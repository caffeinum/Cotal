/**
 * The connector's local control plane: a unix-socket server the lifecycle hooks
 * talk to. Hooks are dumb relays — they forward the raw runtime event JSON (which
 * carries `hook_event_name`) and print whatever we reply. All the logic lives here,
 * in-process, because this is where the live mesh endpoint is.
 *
 * The socket plumbing is platform-agnostic; each connector passes a {@link HookHandle}
 * that maps its runtime's events to presence changes + (for inject-capable events)
 * queued peer messages, in that runtime's own hook-output shape.
 */
import { createServer, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { MeshAgent, InboxItem } from "./agent.js";

/** One lifecycle event, as the agent runtime delivers it on stdin. */
export interface HookEvent {
  hook_event_name?: string;
  [k: string]: unknown;
}

/** Maps one hook event to the JSON reply the runtime applies. */
export type HookHandle = (agent: MeshAgent, ev: HookEvent) => Promise<Record<string, unknown>>;

function who(i: InboxItem): string {
  return i.fromRole ? `${i.fromName}/${i.fromRole}` : i.fromName;
}

function fmtItem(i: InboxItem): string {
  const h = i.historical ? " (history)" : ""; // backfilled on join — pre-dates you, not live
  if (i.kind === "dm") return `• DM from ${who(i)}${h}: ${i.text}`;
  if (i.kind === "anycast") return `• @${i.service} (from ${who(i)})${h}: ${i.text}`;
  return `• #${i.channel} ${who(i)}${h}: ${i.text}`;
}

/** The context block injected into a turn when peer messages are waiting (else undefined). */
export function formatInjection(items: InboxItem[]): string | undefined {
  if (!items.length) return undefined;
  const head = `📨 Cotal — ${items.length} new message${items.length === 1 ? "" : "s"} from peers:`;
  const tail = `(Reply with cotal_send / cotal_dm, or cotal_roster to see who's here.)`;
  return `${head}\n${items.map(fmtItem).join("\n")}\n${tail}`;
}

/** Start the control socket. One newline-delimited JSON request → one reply per connection. */
export function startControlServer(
  agent: MeshAgent,
  socketPath: string,
  handle: HookHandle,
): Server {
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
    process.stderr.write(`[cotal-connector] control server error: ${(e as Error).message}\n`),
  );
  server.listen(socketPath, () =>
    process.stderr.write(`[cotal-connector] control socket: ${socketPath}\n`),
  );
  return server;
}
