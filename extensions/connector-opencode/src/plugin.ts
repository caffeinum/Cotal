/**
 * The Cotal OpenCode plugin — loaded in-process by `opencode serve` (via the inline
 * config the connector sets). It turns the session into a first-class mesh peer:
 *
 *  • holds the {@link MeshAgent} (NATS endpoint, inbox, presence) for the server lifetime;
 *  • registers the cotal_* tools natively (no separate MCP server — one mesh endpoint);
 *  • maps OpenCode bus events to presence (idle | working | waiting | offline);
 *  • drives the session: an incoming peer message wakes a turn by injecting a prompt over
 *    the in-process SDK client (`promptAsync`). OpenCode rejects a prompt mid-turn, so we
 *    queue and drain on idle; a *directed* message (DM / anycast / @mention) aborts the
 *    running turn so it drains now.
 *
 * Identity comes from COTAL_* env (the plugin runs in the opencode process and inherits it).
 * No identity → inert, so an operator's own `opencode` never joins as a stray peer.
 */
import { loadAgentFile, type PresenceStatus } from "@cotal-ai/core";
import { configFromEnv, hasIdentity, MeshAgent, type InboxItem } from "@cotal-ai/connector-core";
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { buildCotalTools } from "./tools.js";

/** Parse an agent-file `model` ("provider/model") into the SDK's shape. Without a
 *  provider we can't address it — return undefined and let opencode use its default. */
function parseModel(s?: string): { providerID: string; modelID: string } | undefined {
  if (!s) return undefined;
  const i = s.indexOf("/");
  return i > 0 ? { providerID: s.slice(0, i), modelID: s.slice(i + 1) } : undefined;
}

function log(msg: string): void {
  process.stderr.write(`[cotal-connector] ${msg}\n`);
}

/** Process-global guard: opencode loads the plugin once per app/worktree scope, so the
 *  function can run more than once in a single `serve` process. We want exactly one mesh
 *  endpoint — so the first call wires up the agent, and every call returns the *same*
 *  hooks (the same tools, bound to that one agent), whichever scope opencode ends up using. */
const guard = globalThis as { __cotalOpencodeHooks?: Hooks };

export const cotal: Plugin = async ({ client }) => {
  // No identity → a plain `opencode`, not a launcher-spawned agent. Stay inert.
  if (!hasIdentity()) {
    log("no COTAL_NAME — not a managed session; staying off the mesh");
    return {};
  }
  if (guard.__cotalOpencodeHooks) return guard.__cotalOpencodeHooks; // one agent; reuse the hooks
  const config = configFromEnv();
  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry — never blocks startup

  const def = process.env.COTAL_AGENT_FILE?.trim() ? loadAgentFile(process.env.COTAL_AGENT_FILE.trim()) : undefined;
  const persona = def?.persona;
  const model = parseModel(process.env.COTAL_OPENCODE_MODEL?.trim() ?? def?.model);

  // The single driveable session — created lazily on the first wake so startup never
  // races the server coming up.
  let sessionID: string | undefined;
  let busy = false; // a turn is running → must not prompt (opencode throws BusyError)
  let driving = false; // re-entrancy guard around an in-flight promptAsync
  let primed = false; // persona is sent as `system` once, on the first turn
  let surfaced: string[] = []; // ids surfaced into the current turn, acked on completion (by id, not count)
  let interrupted = false; // we aborted the turn to re-prioritize → don't ack it, re-drive
  let awaitingTurnEnd = false; // a turn is in flight → ignore a duplicate idle that isn't its end

  const safeStatus = async (status: PresenceStatus, activity?: string): Promise<void> => {
    try {
      if (agent.connected) await agent.setStatus(status, activity);
    } catch {
      /* presence is best-effort — never throw into opencode */
    }
  };

  async function ensureSession(): Promise<string | undefined> {
    if (sessionID) return sessionID;
    try {
      const res = await client.session.create({ body: { title: `cotal:${config.space}:${config.name}` } });
      sessionID = res.data?.id;
    } catch (e) {
      log(`session.create failed: ${(e as Error).message}`);
    }
    return sessionID;
  }

  function formatWake(items: InboxItem[]): string {
    const head = `📨 Cotal — ${items.length} new message${items.length === 1 ? "" : "s"} from peers:`;
    const body = items.map((i) => {
      if (i.kind === "dm") return `• DM from ${i.fromName}: ${i.text}`;
      if (i.kind === "anycast") return `• @${i.service} (from ${i.fromName}): ${i.text}`;
      return `• #${i.channel}${i.mentionsMe ? " @you" : ""} ${i.fromName}: ${i.text}`;
    });
    const tail = `(Reply with cotal_send / cotal_dm, or cotal_roster to see who's here. Reply only when a reply is needed.)`;
    return `${head}\n${body.join("\n")}\n${tail}`;
  }

  async function drive(): Promise<void> {
    // The MeshAgent inbox is the queue. Guard re-entrancy synchronously before any await.
    if (driving || busy) return;
    driving = true;
    try {
      const id = await ensureSession();
      if (!id) return;
      const items = agent.peekInbox(); // peek, not drain — ack only once the turn accepts
      if (items.length === 0) return;
      const parts = [{ type: "text" as const, text: formatWake(items) }];
      const body: { parts: typeof parts; system?: string; model?: { providerID: string; modelID: string } } = { parts };
      if (!primed && persona) body.system = persona;
      if (model) body.model = model;
      busy = true;
      surfaced = items.map((i) => i.id);
      // Fire-and-forget: the turn runs async (presence follows the bus events). We surfaced
      // these from the inbox but do NOT ack yet — drainInbox runs on turn completion
      // (ack-on-surface), so a crash, error, or an abort mid-turn redelivers them.
      await client.session.promptAsync({ path: { id }, body });
      awaitingTurnEnd = true; // armed: now exactly one completion event ends this turn
      primed = true;
    } catch (e) {
      busy = false;
      surfaced = [];
      log(`drive failed: ${(e as Error).message}`);
    } finally {
      driving = false;
    }
  }

  /** Ack the surfaced batch — but only the leading run STILL at the front of the inbox, matched
   *  by id. MeshAgent evicts from the FRONT at MAX_INBOX, so a long turn on a chatty channel can
   *  shift our surfaced prefix out; matching by id (not a raw count) means we never ack the wrong,
   *  newer messages. Evicted items were already acked by the overflow; any surfaced survivor that
   *  no longer leads is left unacked → redelivered (re-answered, never lost). */
  function ackSurfaced(): void {
    if (surfaced.length === 0) return;
    const front = agent.peekInbox();
    let n = 0;
    while (n < surfaced.length && n < front.length && front[n].id === surfaced[n]) n++;
    if (n > 0) agent.drainInbox(n);
    surfaced = [];
  }

  /** A turn ended (the sole ack site). Ignore a stray/duplicate idle that isn't our turn's
   *  end. Ack what the turn consumed — unless we aborted it to re-prioritize, where the batch
   *  stays unacked and is re-driven with the interrupting message — then drive the next batch. */
  function completeTurn(): void {
    if (!awaitingTurnEnd) return;
    awaitingTurnEnd = false;
    busy = false;
    if (interrupted) interrupted = false;
    else ackSurfaced();
    void drive();
  }

  // Two tiers: a directed message (DM / anycast / @mention) interrupts a busy turn — the
  // abort lands an idle event that drains it now; ambient channel chatter waits for idle.
  // The message itself waits in the MeshAgent inbox (unacked) until drive() surfaces it.
  agent.on("incoming", (item: InboxItem) => {
    const directed = item.kind !== "channel" || item.mentionsMe;
    if (busy) {
      // Directed (DM / anycast / @mention): interrupt now. The in-flight batch stays unacked
      // and is re-driven with this message when the abort completes the turn.
      if (directed && sessionID) {
        interrupted = true;
        void client.session.abort({ path: { id: sessionID } }).catch(() => {});
      }
    } else {
      void drive();
    }
  });

  const ours = (id?: string): boolean => !sessionID || id === sessionID;

  const hooks: Hooks = {
    tool: buildCotalTools(agent, config),

    event: async ({ event }) => {
      switch (event.type) {
        case "session.idle":
          if (!ours(event.properties.sessionID)) return;
          await safeStatus("idle");
          completeTurn(); // the sole turn-end site: ack-on-surface + drive the next batch
          break;
        case "session.status": {
          if (!ours(event.properties.sessionID)) return;
          const s = event.properties.status;
          // Presence only — session.idle owns ack + drive (so a duplicate idle can't mis-ack).
          if (s.type === "busy") {
            busy = true;
            await safeStatus("working");
          } else if (s.type === "idle") {
            await safeStatus("idle");
          } else if (s.type === "retry") {
            await safeStatus("working", `retrying: ${s.message}`);
          }
          break;
        }
        case "permission.updated":
          if (!ours(event.properties.sessionID)) return;
          await safeStatus("waiting", event.properties.title);
          break;
        case "session.error":
          if (!ours(event.properties.sessionID)) return;
          if (!awaitingTurnEnd) return; // no in-flight turn to fail
          awaitingTurnEnd = false;
          // Turn surfaced the batch but failed — ack it (don't retry-loop) and move on.
          ackSurfaced();
          interrupted = false;
          busy = false;
          await safeStatus("idle");
          void drive();
          break;
        case "session.deleted":
          if (!ours(event.properties.info.id)) return;
          await safeStatus("offline");
          break;
      }
    },

    // Surface the running tool as presence activity (parity with Claude's PreToolUse).
    "tool.execute.before": async (input) => {
      if (!ours(input.sessionID)) return;
      await safeStatus("working", input.tool);
    },

    dispose: async () => {
      await safeStatus("offline");
      await agent.stop();
    },
  };

  guard.__cotalOpencodeHooks = hooks;
  log(`opencode plugin ready — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}`);
  return hooks;
};
