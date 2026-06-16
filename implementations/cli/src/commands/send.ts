import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  authDir,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  unicastSubject,
  type CotalMessage,
} from "@cotal-ai/core";
import { c } from "../ui.js";

/**
 * One-shot send commands — `cotal dm` / `cotal msg` / `cotal ask` — the headless equivalents of the
 * console's `:dm` / `:msg` / `:ask`. Each connects, sends one message over the matching delivery
 * mode (`unicast` / `multicast` / `anycast`), and exits. Fire-and-forget by default; `dm --wait`
 * additionally blocks for the agent's reply.
 */

const SEND_OPTS = {
  space: { type: "string" },
  server: { type: "string" },
  creds: { type: "string" },
} as const;

/** Extra options only `dm` honours — wait for the agent's reply, with a timeout. */
const DM_OPTS = {
  ...SEND_OPTS,
  wait: { type: "boolean" },
  timeout: { type: "string" },
} as const;

/** How long `--wait` blocks for a reply before giving up (ms). */
const DEFAULT_WAIT_MS = 60_000;

type SendValues = { space?: string; server?: string; creds?: string };

/** Render a message's text parts into one line. */
function renderText(msg: CotalMessage): string {
  return msg.parts
    .map((p) => (p.kind === "text" ? p.text : `[${p.kind}]`))
    .join(" ")
    .trim();
}

/** Resolve space/server/creds and open a transient, write-capable sender, the way `cotal web` does:
 *  an explicit `--creds` wins; else self-mint from `.cotal/auth` so the send is allowed; else
 *  connect bare on an open mesh. The endpoint watches presence so name→id resolution works (`dm`).
 *  By default it stays off the roster and binds no inbox; pass `addressableAs` to register presence
 *  under that name so a peer can DM back (used by `dm --wait`). The caller stops it. */
async function connectSender(
  values: SendValues,
  opts: { addressableAs?: string } = {},
): Promise<{ ep: CotalEndpoint; space: string }> {
  const server = values.server ?? DEFAULT_SERVER;
  let creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  let space = values.space;
  if (!creds) {
    const auth = loadSpaceAuth(authDir(process.cwd()));
    if (auth) {
      if (space && space !== auth.space) {
        console.error(
          c.red(`Auth here is for space "${auth.space}", not "${space}". Use --space ${auth.space} (or pass --creds).`),
        );
        process.exit(1);
      }
      space = auth.space;
      creds = await mintCreds(auth, newIdentity(), "manager");
    }
  }
  space = space ?? DEFAULT_SPACE;
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: Boolean(opts.addressableAs),
    watchPresence: true,
    card: { name: opts.addressableAs ?? "send", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  return { ep, space };
}

/** Split `<target> <text…>` positionals, stripping a leading `@`/`#` from the target. */
function targetAndText(positionals: string[], strip: RegExp): { target?: string; text: string } {
  return { target: positionals[0]?.replace(strip, ""), text: positionals.slice(1).join(" ").trim() };
}

/** `cotal dm <agent> "<text>"` — one unicast to a peer by name, then exit. With `--wait` it stays
 *  connected (and addressable on the roster) until the agent replies or `--timeout <s>` elapses. */
export async function dm(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: DM_OPTS });
  const { target, text } = targetAndText(positionals, /^@/);
  if (!target || !text) {
    console.error('usage: cotal dm <agent> "<text>"  [--wait] [--timeout <s>] [--space <s>] [--server <url>] [--creds <path>]');
    process.exit(1);
  }
  const waitForReply = values.wait ?? false;
  const waitMs = values.timeout ? Number(values.timeout) * 1000 : DEFAULT_WAIT_MS;
  // With --wait we must be addressable so the agent can resolve us as a reply target off the
  // roster; otherwise stay invisible. The DM still carries the operator name as `from`.
  const operator = (() => {
    try {
      return userInfo().username || "operator";
    } catch {
      return "operator";
    }
  })();
  const { ep, space } = await connectSender(values, waitForReply ? { addressableAs: operator } : {});
  // Presence arrives asynchronously after connect; poll briefly (≤2s) for the target to appear.
  const want = target.toLowerCase();
  const find = (): string | undefined =>
    ep.getRoster().find((p) => p.card.name.toLowerCase() === want)?.card.id;
  let id = find();
  for (let i = 0; i < 20 && !id; i++) {
    await new Promise((r) => setTimeout(r, 100));
    id = find();
  }
  if (!id) {
    console.error(c.red(`no agent "${target}" present in space ${space}`));
    await ep.stop();
    process.exit(1);
  }

  // With --wait, tap our own inbox (inst.<me>.*) BEFORE sending so a fast reply isn't missed.
  let replied: Promise<CotalMessage | undefined> | undefined;
  if (waitForReply) {
    const targetId = id;
    replied = new Promise<CotalMessage | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), waitMs);
      ep.tap(
        (_subject, msg) => {
          if (msg && msg.from.id === targetId) {
            clearTimeout(timer);
            resolve(msg);
          }
        },
        { subject: unicastSubject(space, ep.ref().id, "*") },
      );
    });
  }

  await ep.unicast(id, text);
  console.log(c.green(`→ ${target}`) + c.dim(`  ${text}`));

  if (replied) {
    console.log(c.dim(`  waiting for reply (${Math.round(waitMs / 1000)}s)…`));
    const reply = await replied;
    if (reply) {
      console.log(c.green(`← ${target}: `) + renderText(reply));
    } else {
      console.log(c.dim(`  no reply within ${Math.round(waitMs / 1000)}s — watch the feed: cotal watch --space ${space}`));
    }
  }
  await ep.stop();
}

/** `cotal msg <channel> "<text>"` — one broadcast to a channel, then exit. */
export async function msg(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: SEND_OPTS });
  const { target: channel, text } = targetAndText(positionals, /^#/);
  if (!channel || !text) {
    console.error('usage: cotal msg <channel> "<text>"  [--space <s>] [--server <url>] [--creds <path>]');
    process.exit(1);
  }
  const { ep } = await connectSender(values);
  await ep.multicast(text, { channel });
  console.log(c.green(`→ #${channel}`) + c.dim(`  ${text}`));
  await ep.stop();
}

/** `cotal ask <role> "<text>"` — one anycast to a role/service (exactly one instance), then exit. */
export async function ask(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: SEND_OPTS });
  const { target: role, text } = targetAndText(positionals, /^@/);
  if (!role || !text) {
    console.error('usage: cotal ask <role> "<text>"  [--space <s>] [--server <url>] [--creds <path>]');
    process.exit(1);
  }
  const { ep } = await connectSender(values);
  await ep.anycast(role, text);
  console.log(c.green(`→ @${role}`) + c.dim(`  ${text}`));
  await ep.stop();
}
