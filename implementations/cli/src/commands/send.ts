import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  authDir,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { mentionsIn } from "../console/commands.js";

/**
 * One-shot send commands — `cotal dm` / `cotal msg` / `cotal ask` — the headless equivalents of the
 * console's `:dm` / `:msg` / `:ask`. Each connects, sends one message over the matching delivery
 * mode (`unicast` / `multicast` / `anycast`), and exits. Fire-and-forget: no reply waiting.
 */

const SEND_OPTS = {
  space: { type: "string" },
  server: { type: "string" },
  creds: { type: "string" },
} as const;

type SendValues = { space?: string; server?: string; creds?: string };

/** Resolve space/server/creds and open a transient, write-capable sender, the way `cotal web` does:
 *  an explicit `--creds` wins; else self-mint from `.cotal/auth` so the send is allowed; else
 *  connect bare on an open mesh. The endpoint never registers on the roster and binds no inbox; it
 *  watches presence so name→id resolution works (`dm`). The caller stops it. */
async function connectSender(values: SendValues): Promise<{ ep: CotalEndpoint; space: string }> {
  const server = values.server ?? DEFAULT_SERVER;
  let creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  let space = values.space;
  if (!creds) {
    const auth = loadSpaceAuth(authDir(cotalRoot()));
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
    registerPresence: false,
    watchPresence: true,
    card: { name: "send", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  return { ep, space };
}

/** Split `<target> <text…>` positionals, stripping a leading `@`/`#` from the target. */
function targetAndText(positionals: string[], strip: RegExp): { target?: string; text: string } {
  return { target: positionals[0]?.replace(strip, ""), text: positionals.slice(1).join(" ").trim() };
}

/** `cotal dm <agent> "<text>"` — one unicast to a peer by name, then exit. */
export async function dm(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: SEND_OPTS });
  const { target, text } = targetAndText(positionals, /^@/);
  if (!target || !text) {
    console.error('usage: cotal dm <agent> "<text>"  [--space <s>] [--server <url>] [--creds <path>]');
    process.exit(1);
  }
  const { ep, space } = await connectSender(values);
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
  await ep.unicast(id, text);
  console.log(c.green(`→ ${target}`) + c.dim(`  ${text}`));
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
  await ep.multicast(text, { channel, mentions: mentionsIn(text) });
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
