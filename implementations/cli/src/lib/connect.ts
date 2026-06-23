import { readFileSync } from "node:fs";
import {
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  findMesh,
  getCurrent,
  mintCreds,
  newIdentity,
  probeConnect,
  removeMesh,
  resolveMeshTarget,
  type MeshTarget,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { pruneStaleMeshes } from "./meshes.js";

/**
 * The one way every command that touches a running mesh figures out WHICH mesh + with what creds,
 * and confirms it's actually up — so `spawn`, `send`/`dm`/`msg`/`ask`, `console`, `join`, `web`,
 * `channels`, `history`, and `personas --running` all behave identically from any directory instead
 * of each re-deriving it from a cwd walk-up (which mistook `$HOME/.cotal` for a space and crashed
 * with a raw NATS auth violation). Two escape hatches take a RAW off-registry connection (no
 * registry lookup, no stale-prune): explicit `--creds`, and `--server` + an unregistered `--space`
 * (an open remote mesh that has no creds to pass).
 */

export interface ConnectFlags {
  server?: string;
  space?: string;
  /** Explicit creds file — triggers a raw off-registry connection (see {@link connectOrExit}). */
  creds?: string;
}

/** Raw NATS auth for an off-registry connection — a join link / --token / --user+--pass / --creds.
 *  Structurally matches what `probeConnect` accepts. */
export interface RawAuth {
  token?: string;
  user?: string;
  pass?: string;
  creds?: string;
  tls?: boolean;
}

export interface Connection {
  server: string;
  space: string;
  creds?: string;
  /** The mesh's trust material when resolved from the registry on an auth mesh — undefined for an
   *  open mesh or a raw off-registry connection (`--creds` or `--server`+unregistered `--space`).
   *  (web keeps it for its per-delete manager mint.) */
  auth?: SpaceAuth;
}

/**
 * Resolve where a mesh-touching command connects + with what creds.
 *  • Explicit `--creds` → a RAW off-registry connection: straight to `--server` (default loopback)
 *    as `--space`, with those creds. No registry lookup, no stale-prune, plain reachability message
 *    (the user is deliberately off-registry — e.g. a remote mesh that isn't locally recorded).
 *  • Otherwise → resolve the running mesh from the registry (works from any dir), mint `role` creds
 *    on an auth mesh, and preflight with the registry's stale-prune.
 */
export async function connectOrExit(flags: ConnectFlags, role: Profile): Promise<Connection> {
  if (flags.creds) {
    const server = flags.server ?? DEFAULT_SERVER;
    const space = flags.space ?? DEFAULT_SPACE;
    const creds = readFileSync(flags.creds, "utf8");
    await reachableOrExit(server, { creds });
    return { server, space, creds };
  }
  // A raw OPEN remote mesh: explicit `--server` + a `--space` that isn't locally registered. Naming
  // both is as deliberate as `--creds`, but an open broker has no creds to pass — connect bare,
  // off-registry (no registry lookup, no prune). A registered `--space` still goes through the
  // resolver below (which honors `--server` as an override); `--server` alone resolves there too.
  if (flags.server && flags.space && !findMesh(flags.space)) {
    await reachableOrExit(flags.server, {});
    return { server: flags.server, space: flags.space };
  }
  const target = await resolveTargetOrExit({ server: flags.server, space: flags.space });
  const creds = target.auth ? await mintCreds(target.auth, newIdentity(), role) : undefined;
  await preflightOrExit(target, creds);
  return { server: target.server, space: target.space, creds, auth: target.auth };
}

/** Reachability check for a RAW (off-registry) connection — one plain sentence, never a registry/
 *  stale-entry message and never a prune. Used by the `--creds` escape hatch and `join`'s explicit
 *  (link/token/creds) path, both of which connect to a broker the user named, not the registry. */
export async function reachableOrExit(server: string, auth: RawAuth = {}): Promise<void> {
  const probe = await probeConnect(server, auth);
  if (probe.ok) return;
  console.error(
    c.red(
      probe.reason === "auth-required"
        ? `✗ credentials rejected at ${server} — check your creds, or the broker wants different auth`
        : `✗ can't reach a broker at ${server} — is it running? (\`cotal up\`)`,
    ),
  );
  process.exit(1);
}

/** Resolve the mesh a command targets, exiting with one human sentence on an unresolved/ambiguous
 *  registry rather than a stack trace. Prunes dead registry entries first so a crashed mesh doesn't
 *  block a bare command or get offered by `--space`. */
export async function resolveTargetOrExit(flags: {
  server?: string;
  space?: string;
}): Promise<MeshTarget> {
  await pruneStaleMeshes();
  let target: MeshTarget;
  try {
    target = resolveMeshTarget(process.cwd(), flags);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  // If a dangling `current` was silently bypassed — it named a mesh that's since gone and we fell
  // back to the only live one — say so. The N>1 case errors loudly; this is the one spot that would
  // otherwise quietly redirect a stale default.
  const cur = getCurrent();
  if (cur && !findMesh(cur) && target.source === "registry")
    console.error(c.dim(`note: default mesh "${cur}" is down — using "${target.space}"`));
  return target;
}

/** The five distinct ways a preflight fails. Each also says whether the target OWNS its registry
 *  entry (→ prune): `fromRegistry` means the server+mode came from a registry record (incl. a
 *  `local-recorded` project matched by root), so a definitive failure is a stale-entry signal. */
export type PreflightFailure =
  | "unreachable"
  | "registry-creds-rejected"
  | "registry-open-now-auth"
  | "creds-rejected"
  | "open-wants-auth";

/** Pure decision for {@link preflightOrExit} — separated from I/O so the whole branch tree is
 *  unit-testable (it's the riskiest new logic: a wrong branch prunes a LIVE registry entry). A
 *  non-registry source (`flag-server`/`local-space`, or a raw `--creds` connection) is NEVER pruned;
 *  the user owns that diagnosis. */
export function classifyPreflightFailure(
  source: MeshTarget["source"],
  reason: "auth-required" | "unreachable",
  hasAuth: boolean,
): { prune: boolean; kind: PreflightFailure } {
  const fromRegistry =
    source === "registry" ||
    source === "current" ||
    source === "flag-space" ||
    source === "local-recorded";
  if (reason === "unreachable") return { prune: fromRegistry, kind: "unreachable" };
  if (fromRegistry && hasAuth) return { prune: true, kind: "registry-creds-rejected" };
  if (fromRegistry) return { prune: true, kind: "registry-open-now-auth" };
  if (hasAuth) return { prune: false, kind: "creds-rejected" };
  return { prune: false, kind: "open-wants-auth" };
}

function preflightMessage(kind: PreflightFailure, t: MeshTarget, pruned: boolean): string {
  switch (kind) {
    case "unreachable":
      return `✗ no mesh running at ${t.server}${pruned ? " (stale registry entry — removed)" : ""} — run \`cotal up\``;
    case "registry-creds-rejected":
      return `✗ mesh "${t.space}" at ${t.server} no longer matches its registry entry (credentials rejected — port reused?) — re-run \`cotal up\` from ${t.root}, or \`cotal meshes\` to see what's live`;
    case "registry-open-now-auth":
      return `✗ open mesh "${t.space}" at ${t.server} no longer matches its registry entry (broker now requires auth — port reused?) — re-run \`cotal up\` from ${t.root}, or \`cotal meshes\` to see what's live`;
    case "creds-rejected":
      return `✗ credentials for "${t.space}" were rejected at ${t.server} — a different mesh may be running there. Run \`cotal meshes\` to check, or \`cotal up\` here to start yours`;
    case "open-wants-auth":
      return `✗ broker at ${t.server} requires auth, but this mesh is open (no trust material) — use \`--space <name>\` for an auth mesh, or run \`cotal up\` here without \`--open\``;
  }
}

/** Confirm the resolved mesh is up and accepts these creds — replaces the raw NATS "Authorization
 *  Violation" trace with one sentence, and prunes the entry if the broker is gone / mismatched.
 *  Probes with `probeCreds` when given (the caller's `--creds`/minted creds); otherwise mints a
 *  throwaway identity from the target's own trust material. */
export async function preflightOrExit(target: MeshTarget, probeCreds?: string): Promise<void> {
  const creds =
    probeCreds ?? (target.auth ? await mintCreds(target.auth, newIdentity(), "manager") : undefined);
  const probe = await probeConnect(target.server, creds ? { creds } : {});
  if (probe.ok) return;
  const { prune, kind } = classifyPreflightFailure(target.source, probe.reason, Boolean(target.auth));
  if (prune) removeMesh(target.space);
  console.error(c.red(preflightMessage(kind, target, prune)));
  process.exit(1);
}
