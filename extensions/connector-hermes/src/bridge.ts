/**
 * The Hermes adapter bridge — a local unix-socket server the in-gateway Python plugin connects
 * to. It is the half of the integration that connector-core's one-shot control socket (used for
 * presence hooks, via the relay.ts pattern) can't do: a **persistent, bidirectional** channel so
 * the sidecar can *push* inbound mesh messages into a live gateway turn (wake / queue / interrupt)
 * and the plugin can route turn replies + cotal_* tool calls back out over the same {@link MeshAgent}.
 *
 * Wire format: newline-delimited JSON, both directions.
 *
 *   Python → sidecar
 *     {t:"subscribe"}                         adapter: start receiving inbound pushes
 *     {t:"delivered", id}                     adapter: turn accepted msg <id> → ack it on the stream
 *     {t:"reply", target, text}               adapter: route a turn's reply back to its origin
 *     {t:"tool", id, op, args}                tools: invoke a cotal op (send/dm/anycast/status/…)
 *
 *   sidecar → Python
 *     {t:"incoming", msg}                      push one buffered mesh message (for handle_message)
 *     {t:"tool_result", id, ok, data?, error?} reply to a {t:"tool"} request
 *
 * Delivery is **serial + ack-on-surface**: the sidecar pushes the oldest buffered message, waits
 * for the adapter's `delivered`, then `drainInbox(1)` acks exactly that message before pushing the
 * next. A crash before `delivered` redelivers — nothing is lost, matching the stream-backed inbox
 * contract. (One adapter connection at a time; a fresh `subscribe` supersedes the previous.)
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { PresenceStatus } from "@cotal-ai/core";
import type { MeshAgent, InboxItem } from "@cotal-ai/connector-core";

/** Reply routing target the adapter derives from a turn's session/chat id. */
interface ReplyTarget {
  channel?: string;
  /** Peer instance id (or name) for a DM/anycast reply. */
  peerId?: string;
}

function log(msg: string): void {
  process.stderr.write(`[cotal-hermes/bridge] ${msg}\n`);
}

/** The inbox item, flattened for the Python side (handle_message builds a MessageEvent from it). */
function wireItem(i: InboxItem): Record<string, unknown> {
  return {
    id: i.id,
    ts: i.ts,
    kind: i.kind,
    channel: i.channel,
    service: i.service,
    fromId: i.fromId,
    fromName: i.fromName,
    fromRole: i.fromRole,
    mentions: i.mentions,
    mentionsMe: i.mentionsMe,
    text: i.text,
    replyTo: i.replyTo,
    contextId: i.contextId,
  };
}

export interface BridgeServer {
  close(): void;
}

/** Start the adapter bridge. Returns a handle whose `close()` stops the server. */
export function startBridgeServer(agent: MeshAgent, socketPath: string): BridgeServer {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath); // clear a stale socket from a dead predecessor
    } catch {
      /* ignore */
    }
  }

  /** The single subscribed adapter connection, and the id we're currently awaiting an ack for. */
  let adapter: Socket | undefined;
  let awaitingId: string | undefined;

  const sendFrame = (sock: Socket, frame: Record<string, unknown>): void => {
    try {
      sock.write(JSON.stringify(frame) + "\n");
    } catch (e) {
      log(`write failed: ${(e as Error).message}`);
    }
  };

  /** Push the oldest buffered message to the adapter, one at a time. Acks happen only on the
   *  adapter's `delivered` (see below), so a turn that never surfaces a message redelivers it. */
  const pump = (): void => {
    if (!adapter || awaitingId) return;
    const pending = agent.peekInbox();
    if (!pending.length) return;
    const next = pending[0];
    awaitingId = next.id;
    sendFrame(adapter, { t: "incoming", msg: wireItem(next) });
  };

  agent.on("incoming", () => pump());
  // The Stop→idle batch flush (see the hook handle): an idle gateway has nothing in flight, so a
  // wake is just another reason to drain whatever is buffered.
  agent.on("wake", () => pump());

  const onReply = async (target: ReplyTarget, text: string): Promise<void> => {
    if (!text.trim()) return;
    if (target.channel) await agent.send(text, target.channel);
    else if (target.peerId) await agent.dm(target.peerId, text);
  };

  const onTool = async (op: string, args: Record<string, unknown>): Promise<unknown> => {
    const s = (k: string): string => String(args[k] ?? "");
    switch (op) {
      case "roster":
        return agent.roster().map((p) => ({
          name: p.card.name,
          role: p.card.role,
          status: p.status,
          activity: p.activity,
          me: p.card.id === agent.id,
        }));
      case "status":
        await agent.setStatus(s("status") as PresenceStatus, args.activity ? s("activity") : undefined);
        return { ok: true };
      case "send":
        return { channel: (await agent.send(s("text"), args.channel ? s("channel") : undefined, args.mentions as string[] | undefined)).channel };
      case "dm":
        return { to: (await agent.dm(s("to"), s("text"))).peer.card.name };
      case "anycast":
        await agent.anycast(s("role"), s("text"));
        return { ok: true };
      case "inbox":
        return agent.peekInbox().map(wireItem);
      case "spawn":
        return agent.spawn(s("name"), args.role ? s("role") : undefined);
      default:
        throw new Error(`unknown tool op: ${op}`);
    }
  };

  const handleFrame = async (sock: Socket, frame: Record<string, unknown>): Promise<void> => {
    switch (frame.t) {
      case "subscribe":
        adapter = sock;
        awaitingId = undefined;
        log("adapter subscribed");
        pump();
        return;
      case "delivered":
        if (frame.id && frame.id === awaitingId) {
          // Ack exactly the surfaced message — but ONLY if it's still the front. MeshAgent
          // force-evicts (and acks) from the FRONT at MAX_INBOX, so a 200+ ambient burst during a
          // long turn can already have evicted our in-flight item; draining the front then would
          // mis-ack a newer, unsurfaced message (losing it). If the front is no longer ours, the
          // overflow already acked it — just resync and let pump() surface the new front.
          if (agent.peekInbox()[0]?.id === awaitingId) agent.drainInbox(1);
          awaitingId = undefined;
          pump();
        }
        return;
      case "reply":
        try {
          await onReply((frame.target ?? {}) as ReplyTarget, String(frame.text ?? ""));
        } catch (e) {
          log(`reply failed: ${(e as Error).message}`);
        }
        return;
      case "tool": {
        const id = frame.id;
        try {
          const data = await onTool(String(frame.op), (frame.args ?? {}) as Record<string, unknown>);
          sendFrame(sock, { t: "tool_result", id, ok: true, data });
        } catch (e) {
          sendFrame(sock, { t: "tool_result", id, ok: false, error: (e as Error).message });
        }
        return;
      }
      default:
        log(`unknown frame: ${JSON.stringify(frame).slice(0, 120)}`);
    }
  };

  const server: Server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: Record<string, unknown> = {};
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          log(`malformed frame dropped`);
          continue;
        }
        void handleFrame(sock, frame);
      }
    });
    sock.on("close", () => {
      if (sock === adapter) {
        adapter = undefined;
        awaitingId = undefined;
        log("adapter disconnected");
      }
    });
    sock.on("error", () => {
      /* ignore client errors */
    });
  });

  server.on("error", (e) => log(`server error: ${(e as Error).message}`));
  server.listen(socketPath, () => log(`listening: ${socketPath}`));

  return {
    close() {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}
