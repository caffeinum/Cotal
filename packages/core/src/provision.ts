/**
 * The provisioner — the signer capability for a space.
 *
 * A space is one NATS *account*; every agent is a *user* in it. This module mints the
 * decentralized-JWT trust chain (operator → account → user) programmatically with
 * `@nats-io/jwt`, so there is no dependency on the external `nsc` CLI and the signing
 * key stays in one place (whoever holds {@link SpaceAuth.account.signingSeed}).
 *
 * Demo-1 stage: out-of-band mint. `swarl up` creates the space's trust material
 * once and writes a `nats-server` config (operator + system account + MEMORY resolver);
 * `swarl mint` and the manager load that material and mint per-agent creds files. There
 * is no connect-time token exchange yet (that's the later auth-callout stage).
 *
 * NOT yet provided (our job, not nsc's): credential revocation and an issuance audit
 * trail. Revocation is deferred past Demo 1; minted creds currently have no TTL.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  encodeOperator,
  encodeAccount,
  encodeUser,
  fmtCreds,
} from "@nats-io/jwt";
import { createOperator, createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  token,
  spacePrefix,
  chatSubject,
  unicastSubject,
  anycastSubject,
  controlServiceSubject,
  chatStream,
  dmStream,
  taskStream,
  chatDurable,
  dmDurable,
  taskDurable,
  presenceBucket,
} from "./subjects.js";
import type { Identity } from "./identity.js";

/** Cred profiles (per the plan's class table). Demo-1 mints all permissively; steps 5–7
 *  scope each one — at which point the manager MUST already hold its own privileged
 *  profile (broad: pre-create others' DM durables, serve ctl), not "agent", or it
 *  silently loses those powers the moment "agent" is tightened. */
export type Profile = "agent" | "observer" | "manager";

/** A space's persisted trust material. The `signingSeed` is the sensitive provisioner
 *  secret; everything else is public (JWTs) or recoverable. */
export interface SpaceAuth {
  space: string;
  operator: { seed: string; jwt: string };
  account: { pub: string; seed: string; jwt: string; signingSeed: string; signingPub: string };
  sys: { pub: string; jwt: string };
}

// Unlimited account limits — without explicit limits a JWT account defaults to 0 conns
// (every connect denied). JetStream needs storage on the data account but MUST stay off
// the system account (the server refuses to start otherwise).
const BASE_LIMITS = {
  subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1,
  data: -1, payload: -1, wildcards: true,
} as const;
const DATA_LIMITS = { ...BASE_LIMITS, mem_storage: -1, disk_storage: -1 };
const SYS_LIMITS = { ...BASE_LIMITS, mem_storage: 0, disk_storage: 0 };

/** Generate a fresh operator → account(+signing key) → system-account chain for a space. */
export async function createSpaceAuth(space: string): Promise<SpaceAuth> {
  const okp = createOperator();
  const akp = createAccount();
  const askp = createAccount(); // account signing key — what mints users
  const syskp = createAccount();
  const sysPub = syskp.getPublicKey();

  const operatorJwt = await encodeOperator(`swarl-${token(space)}`, okp, { system_account: sysPub });
  const accountJwt = await encodeAccount(
    token(space),
    akp,
    { signing_keys: [askp.getPublicKey()], limits: DATA_LIMITS },
    { signer: okp },
  );
  const sysJwt = await encodeAccount("SYS", syskp, { limits: SYS_LIMITS }, { signer: okp });

  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  return {
    space,
    operator: { seed: dec(okp.getSeed()), jwt: operatorJwt },
    account: {
      pub: akp.getPublicKey(),
      seed: dec(akp.getSeed()),
      jwt: accountJwt,
      signingSeed: dec(askp.getSeed()),
      signingPub: askp.getPublicKey(),
    },
    sys: { pub: sysPub, jwt: sysJwt },
  };
}

/** Options shaping a minted user's permissions. */
export interface MintOpts {
  /** Channels an "agent" may publish to (the agent file's `publish:` allow-list, already
   *  resolved by the caller). Each is run through the chat-subject builder so a wildcard
   *  subtree like `team.>` becomes `chat.<id>.team.>`. Defaults to `["general"]`. */
  channels?: string[];
  /** The agent's role — scopes its TASK-queue consumer to svc_<role>. */
  role?: string;
  /** Control service the agent may address. Defaults to `"manager"`. */
  manager?: string;
}

/** The privileged onboarding ops a launcher needs — implemented by a connected, permissive
 *  endpoint (the manager, or a short-lived provisioner that `swarl spawn` opens). */
export interface DurableProvisioner {
  provisionDmInbox(id: string): Promise<void>;
  provisionTaskQueue(role: string): Promise<void>;
}

/** Onboard an agent for launch (auth mode): pre-create its bind-only DM (+ role TASK) durables
 *  and mint its scoped creds. The single shared step so every launcher — the manager and
 *  `swarl spawn` alike — provisions identically (manager not special). */
export async function provisionAgent(
  provisioner: DurableProvisioner,
  auth: SpaceAuth,
  identity: Identity,
  opts: MintOpts = {},
): Promise<string> {
  await provisioner.provisionDmInbox(identity.id);
  if (opts.role) await provisioner.provisionTaskQueue(opts.role);
  return mintCreds(auth, identity, "agent", opts);
}

/** Mint a user creds file for an agent {@link Identity} (its stable id+seed from
 *  {@link newIdentity}). The account signing key signs over ONLY the public key
 *  (`fromPublic`) — the agent seed is never part of the signature, it's only folded into
 *  the resulting creds file. The "agent" profile is scoped to publish only as itself and
 *  only to its declared channels (the channel-restriction enforcement); "manager" and
 *  "observer" stay permissive here and are scoped in steps 6–7. */
export async function mintCreds(
  auth: SpaceAuth,
  identity: Identity,
  profile: Profile,
  opts: MintOpts = {},
): Promise<string> {
  const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
  const perms = permissionsFor(profile, auth.space, identity.id, opts);
  const userJwt = await encodeUser(
    profile,
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    perms,
    { signer },
  );
  const creds = fmtCreds(userJwt, fromSeed(new TextEncoder().encode(identity.seed)));
  return new TextDecoder().decode(creds);
}

/** Build the NATS user permission object for a profile: a default-deny allow-list scoped to
 *  exactly what each profile does. "manager" stays permissive (the privileged provisioner
 *  host). Subject/stream/durable names come from the shared builders so the ACLs can't drift
 *  from the wire layout. */
function permissionsFor(
  profile: Profile,
  space: string,
  id: string,
  opts: MintOpts,
): Record<string, unknown> {
  if (profile === "manager") return {}; // privileged: allow-all defaults
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const KV = `KV_${presenceBucket(space)}`;
  const inbox = `_INBOX_${id}.>`;

  if (profile === "observer") {
    // Read-only: live chat via tap (sub chat.>), history + presence via ephemeral/ordered
    // consumers it creates on CHAT + the presence KV. No chat/inst/svc/ctl publish → can't
    // post. DM_<space> never named anywhere → DMs structurally invisible (and step-6 inbox
    // scoping means it can't sniff deliveries either).
    return {
      sub: { allow: [`${spacePrefix(space)}.chat.>`, inbox] },
      pub: {
        allow: [
          "$JS.API.INFO",
          `$JS.API.STREAM.INFO.${CHAT}`,
          `$JS.API.STREAM.INFO.${KV}`,
          `$JS.API.CONSUMER.CREATE.${CHAT}.>`, // ephemeral backlog consumer (channelHistory)
          `$JS.API.CONSUMER.INFO.${CHAT}.>`,
          `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.>`,
          `$JS.ACK.${CHAT}.>`,
          `$JS.API.CONSUMER.CREATE.${KV}.>`, // kv.watch ordered consumer (roster is public)
          `$JS.API.CONSUMER.INFO.${KV}.>`,
          "$JS.FC.>", // ordered-consumer flow control
        ],
      },
    };
  }

  // ---- agent ----
  const channels = opts.channels?.length ? opts.channels : ["general"];
  const manager = opts.manager ?? "manager";
  const chatD = chatDurable(id), dmD = dmDurable(id);
  const svcD = opts.role ? taskDurable(opts.role) : undefined;
  const pubAllow = [
    // peer subjects — identity + channel scope (step 5), built from the real builders.
    ...channels.map((ch) => chatSubject(space, id, ch)),
    unicastSubject(space, "*", id), //  inst.*.<id>   — DM any instance, as me
    anycastSubject(space, "*", id), //  svc.*.<id>    — anycast any role, as me
    controlServiceSubject(space, manager, id), // ctl.<mgr>.<id>
    // JetStream control plane — scoped to this agent's own streams/durables.
    "$JS.API.INFO",
    `$JS.API.STREAM.INFO.${CHAT}`, `$JS.API.STREAM.INFO.${DM}`, `$JS.API.STREAM.INFO.${TASK}`, `$JS.API.STREAM.INFO.${KV}`,
    // CHAT consumer: self-create (chat is world-readable, so name-scope is enough).
    `$JS.API.CONSUMER.DURABLE.CREATE.${CHAT}.${chatD}`,
    `$JS.API.CONSUMER.INFO.${CHAT}.${chatD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.${chatD}`,
    `$JS.ACK.${CHAT}.${chatD}.>`,
    // DM consumer: BIND ONLY — info/fetch/ack its own pre-created durable, never create.
    `$JS.API.CONSUMER.INFO.${DM}.${dmD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmD}`,
    `$JS.ACK.${DM}.${dmD}.>`,
    // Presence: watch (read, public roster) + flow control + PUT OWN KEY ONLY.
    `$JS.API.CONSUMER.CREATE.${KV}.>`,
    `$JS.API.CONSUMER.INFO.${KV}.>`,
    "$JS.FC.>",
    `$KV.${presenceBucket(space)}.${id}`, // own presence key only — can't spoof peers
  ];
  if (svcD) {
    // TASK consumer: BIND ONLY its own role's pre-created durable (svc_<role>). Like DM, the
    // create-time filter_subject isn't reliably ACL-constrainable, so no create path is
    // allowed — the privileged provisioner pre-creates svc_<role> filtered to svc.<role>.*.
    pubAllow.push(
      `$JS.API.CONSUMER.INFO.${TASK}.${svcD}`,
      `$JS.API.CONSUMER.MSG.NEXT.${TASK}.${svcD}`,
      `$JS.ACK.${TASK}.${svcD}.>`,
    );
  }
  // Explicit create-deny (defense-in-depth over default-deny) on the two streams whose
  // create-time filter_subject is the attack surface — DM (private content) and TASK
  // (cross-role work-stealing). Covers the bare ephemeral form (no trailing token), the
  // named/new-API form, and the old durable form. No create path on either stream.
  const pubDeny = [
    `$JS.API.CONSUMER.CREATE.${DM}`,
    `$JS.API.CONSUMER.CREATE.${DM}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${DM}.>`,
    `$JS.API.CONSUMER.CREATE.${TASK}`,
    `$JS.API.CONSUMER.CREATE.${TASK}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${TASK}.>`,
  ];
  return { pub: { allow: pubAllow, deny: pubDeny }, sub: { allow: [inbox] } };
}

/** Render the `nats-server` config that trusts this space's operator and serves its
 *  accounts via the in-config MEMORY resolver. */
export function serverConfig(auth: SpaceAuth, opts: { port?: number; storeDir: string }): string {
  const port = opts.port ?? 4222;
  return `# Generated by \`swarl up\` — do not edit by hand.
port: ${port}
jetstream { store_dir: ${JSON.stringify(opts.storeDir)} }
operator: ${auth.operator.jwt}
system_account: ${auth.sys.pub}
resolver: MEMORY
resolver_preload: {
  ${auth.account.pub}: ${auth.account.jwt}
  ${auth.sys.pub}: ${auth.sys.jwt}
}
`;
}

// ---- persistence (.swarl/auth) ------------------------------------------------

const AUTH_FILE = "auth.json";

export function authDir(root: string): string {
  return join(root, ".swarl", "auth");
}

/** Persist the space trust material. The file holds the signing seed — treat as a secret. */
export function saveSpaceAuth(dir: string, auth: SpaceAuth): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, AUTH_FILE), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

/** Load the space trust material, or undefined if auth was never set up here. */
export function loadSpaceAuth(dir: string): SpaceAuth | undefined {
  const f = join(dir, AUTH_FILE);
  if (!existsSync(f)) return undefined;
  return JSON.parse(readFileSync(f, "utf8")) as SpaceAuth;
}
