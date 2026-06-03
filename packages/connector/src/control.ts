/**
 * The connector's local control plane: a unix-socket server the lifecycle hooks
 * talk to. Hooks are dumb relays — they forward the raw Claude Code event JSON
 * (which carries `hook_event_name`) and print whatever we reply. All the logic
 * lives here, in-process, because this is where the live mesh endpoint is.
 *
 * Replies use Claude Code's hook-output shape; for inject-capable events we
 * surface queued peer messages via `hookSpecificOutput.additionalContext`.
 */
import { createServer, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { MeshAgent, InboxItem } from "./agent.js";

interface HookEvent {
  hook_event_name?: string;
  [k: string]: unknown;
}

function who(i: InboxItem): string {
  return i.fromRole ? `${i.fromName}/${i.fromRole}` : i.fromName;
}

function fmtItem(i: InboxItem): string {
  if (i.kind === "dm") return `• DM from ${who(i)}: ${i.text}`;
  if (i.kind === "anycast") return `• @${i.service} (from ${who(i)}): ${i.text}`;
  return `• #${i.channel} ${who(i)}: ${i.text}`;
}

function injection(items: InboxItem[]): string | undefined {
  if (!items.length) return undefined;
  const head = `📨 Swarl — ${items.length} new message${items.length === 1 ? "" : "s"} from peers:`;
  const tail = `(Reply with swarl_send / swarl_dm, or swarl_roster to see who's here.)`;
  return `${head}\n${items.map(fmtItem).join("\n")}\n${tail}`;
}

/** Dispatch one hook event; returns the JSON to hand back to Claude Code. */
async function handle(agent: MeshAgent, ev: HookEvent): Promise<Record<string, unknown>> {
  const event = ev.hook_event_name ?? "";
  const withContext = (text: string | undefined): Record<string, unknown> =>
    text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
  try {
    switch (event) {
      case "SessionStart":
        await agent.setStatus("idle");
        return withContext(injection(agent.drainInbox()));
      case "UserPromptSubmit":
        await agent.setStatus("working");
        return withContext(injection(agent.drainInbox()));
      case "Notification":
        await agent.setStatus("waiting");
        return {};
      case "Stop":
      case "SessionEnd":
        await agent.setStatus("idle");
        return {};
      default:
        return {};
    }
  } catch {
    return {}; // never block the session
  }
}

/** Start the control socket. One newline-delimited JSON request → one reply per connection. */
export function startControlServer(agent: MeshAgent, socketPath: string): Server {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath); // clear a stale socket from a dead predecessor
    } catch {
      /* ignore */
    }
  }
  const server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return; // wait for the full line
      let ev: HookEvent = {};
      try {
        ev = JSON.parse(buf.slice(0, nl) || "{}") as HookEvent;
      } catch {
        /* malformed — treat as empty */
      }
      const reply = await handle(agent, ev);
      try {
        sock.end(JSON.stringify(reply) + "\n");
      } catch {
        /* client gone */
      }
    });
    sock.on("error", () => {
      /* ignore client errors */
    });
  });
  server.on("error", (e) =>
    process.stderr.write(`[swarl-connector] control server error: ${(e as Error).message}\n`),
  );
  server.listen(socketPath, () =>
    process.stderr.write(`[swarl-connector] control socket: ${socketPath}\n`),
  );
  return server;
}
