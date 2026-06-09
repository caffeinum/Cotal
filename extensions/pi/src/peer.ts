import { MeshAgent, configFromEnv } from "@cotal-ai/connector-core";
import type { InboxItem } from "@cotal-ai/connector-core";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

function log(e: unknown): void {
  process.stderr.write(`[pi-peer] ${e instanceof Error ? e.message : String(e)}\n`);
}

/**
 * Read-only / awareness tools. Replies are NOT sent by the model — the run loop delivers
 * the agent's final text on the right delivery mode (see runPiPeer), so the model can't
 * mis-route or duplicate a reply. These just let it see who is present and report its own
 * status. Mirrors the openai-agents / vercel-ai adapters.
 */
function buildTools(mesh: MeshAgent) {
  const cotal_roster = defineTool({
    name: "cotal_roster",
    label: "Cotal roster",
    description: "List the peers currently present on the Cotal mesh.",
    parameters: Type.Object({}),
    execute: async () => {
      const peers = mesh.roster();
      const text = peers.length
        ? peers
            .map((p) => `${p.card.name}${p.card.role ? `/${p.card.role}` : ""} [${p.status}]`)
            .join("\n")
        : "roster is empty";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  const cotal_status = defineTool({
    name: "cotal_status",
    label: "Cotal status",
    description: "Update this peer's presence status on the mesh.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("idle"), Type.Literal("waiting"), Type.Literal("working")]),
      activity: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      await mesh.setStatus(params.status, params.activity);
      return { content: [{ type: "text", text: `status set to ${params.status}` }], details: {} };
    },
  });

  return [cotal_roster, cotal_status];
}

/** Directed = a DM, an anycast to our role, or a channel message that names us. Pure
 *  ambient channel chatter (and our own echoes) is ignored — same gate as openai-agents. */
function isDirected(mesh: MeshAgent, item: InboxItem): boolean {
  if (item.fromId === mesh.id) return false;
  return item.kind !== "channel" || item.mentionsMe;
}

/** The audience a reply for this message goes back to. A channel message is answered ON
 *  that channel (sender-independent — everyone there already saw it); a DM/anycast is
 *  answered privately to its sender. Two messages with the same scope can safely share one
 *  turn + one reply; mixing scopes cannot (a DM folded into a channel turn would broadcast
 *  private content), so different-scope messages get their own scope-isolated turn. */
function scopeKey(item: InboxItem): string {
  return item.kind === "channel" && item.channel ? `channel:${item.channel}` : `dm:${item.fromId}`;
}

/** Pull this turn's final assistant text from the agent_end payload (not the session-wide
 *  last message), so a turn that produced no text never re-delivers a previous reply. */
function turnReplyText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content
      .map((p) =>
        p && typeof p === "object" && (p as { type?: unknown }).type === "text"
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
    return text.length ? text : undefined;
  }
  return undefined;
}

/**
 * Embed a pi coding-agent session in-process and drive it from mesh traffic. This is the
 * native-embed pattern (cf. docs/agent-frameworks.md): MeshAgent owns the NATS connection,
 * presence, and a stream-backed inbox and emits `"incoming"`; that event drives pi's loop
 * directly — `prompt()` wakes an idle session into a turn, `steer()` interjects into a live
 * one (true mid-turn drive, pi's distinctive capability), and presence is read straight off
 * the session's event stream. The loop owns reply routing, so the model never mis-routes.
 *
 * Each turn is owned by a single reply scope (see scopeKey). A directed message that arrives
 * mid-turn is steered into the running turn only when it shares that scope; a different-scope
 * message is queued and answered in its own turn, so a private DM is never folded into a
 * channel broadcast (and vice-versa).
 */
export async function runPiPeer(): Promise<void> {
  const mesh = new MeshAgent(configFromEnv());
  mesh.start();

  const authStorage = AuthStorage.create();
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage),
    sessionManager: SessionManager.inMemory(),
    customTools: buildTools(mesh),
  });

  // `origin` owns the in-flight turn's reply scope (null = idle). `streaming` gates steer() —
  // same-scope messages that land after prompt() but before the agent is actually streaming
  // are buffered in `preStream` and flushed on agent_start. `pending` holds different-scope
  // messages, drained one turn at a time once the current turn ends.
  let origin: InboxItem | null = null;
  let streaming = false;
  const preStream: string[] = [];
  const pending: InboxItem[] = [];

  const setStatus = (status: "idle" | "working", activity?: string): void => {
    void mesh.setStatus(status, activity).catch(() => {});
  };

  const framed = (item: InboxItem): string =>
    `from ${item.fromName} via ${item.kind}: ${item.text}`;

  function deliver(to: InboxItem, text: string): void {
    if (to.kind === "channel" && to.channel) void mesh.send(text, to.channel).catch(log);
    else void mesh.dm(to.fromId, text).catch(log);
  }

  function startTurn(item: InboxItem): void {
    origin = item;
    streaming = false;
    preStream.length = 0;
    void session.prompt(framed(item)).catch(onTurnError); // wake into a fresh turn
  }

  /** A turn ended (cleanly or via error): clear its state and pick up the next scope. */
  function endTurn(): void {
    origin = null;
    streaming = false;
    preStream.length = 0;
    if (pending.length) startTurn(pending.shift()!);
    else setStatus("idle");
  }

  function onTurnError(e: unknown): void {
    log(e);
    endTurn();
  }

  mesh.on("incoming", (item: InboxItem) => {
    if (!isDirected(mesh, item)) return;
    if (origin === null) {
      startTurn(item);
    } else if (scopeKey(item) === scopeKey(origin)) {
      if (streaming) void session.steer(framed(item)).catch(onTurnError); // interject mid-turn
      else preStream.push(framed(item)); // not streaming yet — flush on agent_start
    } else {
      pending.push(item); // different scope — own turn, own reply
    }
  });

  session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "agent_start":
        streaming = true;
        setStatus("working", "thinking");
        for (const text of preStream.splice(0)) void session.steer(text).catch(onTurnError);
        break;
      case "tool_execution_start":
        setStatus("working", `running ${event.toolName}`);
        break;
      case "tool_execution_end":
        setStatus("working", "thinking"); // clear the per-tool activity so it can't read stale
        break;
      case "agent_end": {
        if (event.willRetry) break; // transient failure; a retry turn follows
        const to = origin;
        const reply = turnReplyText(event.messages);
        endTurn();
        if (to && reply) deliver(to, reply);
        break;
      }
    }
  });

  async function shutdown(): Promise<void> {
    try {
      if (origin !== null) await session.abort(); // interrupt any in-flight turn
      session.dispose();
      await mesh.stop();
    } finally {
      process.exit(0);
    }
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Keep alive.
  await new Promise<void>(() => {});
}
