import { parseArgs } from "node:util";
import {
  resolvePeer,
  AmbiguousPeerError,
  type Presence,
  type CompletionResult,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { openTransient } from "../lib/transient.js";
import { listDeclaredChannels, listDeclaredRoles } from "../lib/personas.js";
import { mentionsIn } from "../lib/mentions.js";

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
  const { ep, space } = await openTransient(values, "send");
  // Presence arrives asynchronously after connect; poll briefly (≤2s) for the target to appear.
  // resolvePeer is fail-loud: an exact id or a unique name resolves, a same-name collision throws.
  let peer: Presence | undefined;
  for (let i = 0; i < 20 && !peer; i++) {
    try {
      peer = resolvePeer(ep.getRoster(), target);
    } catch (e) {
      if (!(e instanceof AmbiguousPeerError)) throw e;
      console.error(c.red(`"${target}" is ambiguous — DM by instance id instead:`));
      for (const cand of e.candidates)
        console.error(c.dim(`  ${cand.name} (${cand.status})  ${cand.id}`));
      await ep.stop();
      process.exit(1);
    }
    if (!peer) await new Promise((r) => setTimeout(r, 100));
  }
  if (!peer) {
    console.error(c.red(`no agent "${target}" present in space ${space}`));
    await ep.stop();
    process.exit(1);
  }
  await ep.unicast(peer.card.id, text);
  console.log(c.green(`→ ${peer.card.name}`) + c.dim(`  ${text}`));
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
  const { ep } = await openTransient(values, "send");
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
  const { ep } = await openTransient(values, "send");
  await ep.anycast(role, text);
  console.log(c.green(`→ @${role}`) + c.dim(`  ${text}`));
  await ep.stop();
}

/** Complete `cotal msg <channel>` from the channels the local persona files *declare* — never the
 *  live broker (a <TAB> stays offline by contract). The label says "declared" because these are
 *  workspace intent, not a claim about what exists on the mesh. Only the channel position
 *  completes; the message text offers nothing. Fail-closed: a malformed agent file throws, so the
 *  completer declines rather than offering a silently-partial set (see {@link listDeclaredChannels}). */
export function msgComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1)
    return {
      items: listDeclaredChannels().map((value) => ({ value, description: "declared channel" })),
      directive: "nofiles",
    };
  return { items: [], directive: "nofiles" };
}

/** Complete `cotal ask <role>` from the roles the local persona files declare — same local-only,
 *  fail-closed contract as {@link msgComplete}. */
export function askComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1)
    return {
      items: listDeclaredRoles().map((value) => ({ value, description: "declared role" })),
      directive: "nofiles",
    };
  return { items: [], directive: "nofiles" };
}
