/**
 * The Cotal OpenCode plugin — loaded in-process by `opencode serve` (via the inline config the
 * connector sets). It turns the session into a first-class mesh peer, at parity with the Claude
 * Code connector:
 *
 *  • holds the {@link MeshAgent} (NATS endpoint, inbox, presence) for the server lifetime;
 *  • registers the cotal_* tools natively, rendered from the SHARED {@link cotalToolSpecs}
 *    (`./tools.ts`) — same surface as Claude/Codex, incl. channels / join / leave / channel_info;
 *  • maps OpenCode bus events to presence (idle | working | waiting | offline);
 *  • drives the session: it surfaces the inbox batch into a turn over the SDK (`promptAsync`),
 *    acking ON TURN COMPLETION (so a crash/error redelivers). Delivery is **attention-aware**
 *    (open/dnd/focus) and never interrupts a running turn — a message that arrives mid-turn waits
 *    for the turn to end (matching Claude's no-interrupt behavior), then drives.
 *
 * Identity comes from COTAL_* env (the plugin runs in the opencode process and inherits it).
 * No identity → inert, so an operator's own `opencode` never joins as a stray peer.
 */
import { loadAgentFile, type PresenceStatus } from "@cotal-ai/core";
import {
  configFromEnv,
  hasIdentity,
  MeshAgent,
  formatInjection,
  fmtFrom,
  type InboxItem,
} from "@cotal-ai/connector-core";
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { buildCotalTools } from "./tools.js";

/** Parse an agent-file `model` ("provider/model") into the SDK's shape. Without a provider we
 *  can't address it — return undefined and let opencode use its default. */
function parseModel(s?: string): { providerID: string; modelID: string } | undefined {
  if (!s) return undefined;
  const i = s.indexOf("/");
  return i > 0 ? { providerID: s.slice(0, i), modelID: s.slice(i + 1) } : undefined;
}

function log(msg: string): void {
  process.stderr.write(`[cotal-connector] ${msg}\n`);
}

/** Process-global guard: opencode loads the plugin once per app/worktree scope, so the function
 *  can run more than once in a single `serve` process. We want exactly one mesh endpoint — so the
 *  first call wires up the agent, and every call returns the *same* hooks (the same tools, bound to
 *  that one agent), whichever scope opencode ends up using. */
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

  // The single driveable session — created lazily on the first wake so startup never races the
  // server coming up.
  let sessionID: string | undefined;
  let busy = false; // a turn is running → don't prompt: opencode would COALESCE onto it (no reject)
  let driving = false; // re-entrancy guard around an in-flight promptAsync
  let primed = false; // persona is sent as `system` once, on the first turn
  let briefed = false; // the boot channel briefing is injected once, on the first turn
  let surfaced: string[] = []; // ids surfaced into the current turn, acked on completion (by id, not count)
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

  /** Inject a turn carrying the current inbox batch (and the boot briefing once). Surfaces the
   *  items but does NOT ack them — ackSurfaced runs on turn completion, so a crash/error/abort
   *  redelivers. `text` overrides the body (a bare nudge, e.g. a focus @mention pull) and surfaces
   *  nothing to ack. Self-guards re-entrancy and never prompts into a running turn. */
  async function drive(override?: string): Promise<void> {
    if (driving || busy) return;
    driving = true;
    try {
      const id = await ensureSession();
      if (!id) return;
      const parts: { type: "text"; text: string }[] = [];
      let ids: string[] = [];
      if (override) {
        parts.push({ type: "text", text: override });
      } else {
        const items = agent.peekInbox();
        if (items.length === 0) return;
        ids = items.map((i) => i.id);
        const inj = formatInjection(items);
        if (inj) parts.push({ type: "text", text: inj });
      }
      if (!briefed) {
        briefed = true;
        const brief = agent.channelBriefing();
        if (brief) parts.unshift({ type: "text", text: brief });
      }
      if (parts.length === 0) return;
      const body: { parts: typeof parts; system?: string; model?: { providerID: string; modelID: string } } = { parts };
      if (!primed && persona) body.system = persona;
      if (model) body.model = model;
      busy = true;
      surfaced = ids;
      // Arm BEFORE the await: a turn-end signal can land before promptAsync resolves, and
      // completeTurn bails unless armed — arming after would drop it and wedge the agent.
      awaitingTurnEnd = true;
      await client.session.promptAsync({ path: { id }, body });
      primed = true;
    } catch (e) {
      busy = false;
      surfaced = [];
      awaitingTurnEnd = false;
      log(`drive failed: ${(e as Error).message}`);
    } finally {
      driving = false;
    }
  }

  /** Ack the surfaced batch — but only the leading run STILL at the front of the inbox, matched by
   *  id. MeshAgent evicts from the FRONT at MAX_INBOX, so a long turn on a chatty channel can shift
   *  our surfaced prefix out; matching by id (not a raw count) means we never ack the wrong, newer
   *  messages. Evicted items were already acked by the overflow; any surfaced survivor that no
   *  longer leads is left unacked → redelivered (re-answered, never lost). */
  function ackSurfaced(): void {
    if (surfaced.length === 0) return;
    const front = agent.peekInbox();
    let n = 0;
    while (n < surfaced.length && n < front.length && front[n].id === surfaced[n]) n++;
    if (n > 0) agent.drainInbox(n);
    surfaced = [];
  }

  /** A turn ended (the sole ack site). Ignore a stray/duplicate idle that isn't our turn's end. Ack
   *  what the turn consumed, then drive the next batch — mode-aware, so bare ambient (dnd/focus)
   *  doesn't self-wake a turn (it rides the next directed turn or a human turn). */
  function completeTurn(): void {
    if (!awaitingTurnEnd) return;
    awaitingTurnEnd = false;
    busy = false;
    ackSurfaced();
    const pending = agent.attention === "open" ? agent.inboxCount() : agent.directedPendingCount();
    if (pending > 0) void drive();
  }

  // Inbound mesh → drive (never interrupt a running turn — matches Claude). A directed message
  // (DM / anycast / @mention) drives when idle; ambient channel chatter drives only in `open` while
  // idle (dnd/focus hold it for the next turn). In `focus`, ambient/@mentions never reach "incoming"
  // (acked-and-dropped at ingest); a focus @mention wakes us to PULL via "mention-wake" below.
  agent.on("incoming", (item: InboxItem) => {
    if (busy) return; // buffer; completeTurn drives at turn end
    const directed = item.kind !== "channel" || item.mentionsMe;
    if (directed || agent.attention === "open") void drive();
  });
  agent.on("mention-wake", (item: InboxItem) => {
    // Focus: the @mention body was acked-and-dropped at ingest — wake a turn to PULL it (recall).
    if (!busy) void drive(`📨 You were mentioned by ${fmtFrom(item)} on #${item.channel ?? "?"} — read it with cotal_inbox.`);
  });
  agent.on("wake", () => {
    if (!busy) void drive();
  });

  const ours = (id?: string): boolean => !sessionID || id === sessionID;

  const hooks: Hooks = {
    tool: buildCotalTools(agent, config),

    event: async ({ event }) => {
      // The server emits `permission.asked` (the SDK's `permission.updated` type ships but never
      // fires — #11616), so match the real runtime name out of band. With permission:"allow" this
      // rarely triggers, but it keeps presence correct if the posture tightens.
      if ((event.type as string) === "permission.asked") {
        const p = event.properties as { sessionID?: string; title?: string };
        if (!p.sessionID || ours(p.sessionID)) await safeStatus("waiting", p.title);
        return;
      }
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
        case "session.error":
          // session.error's sessionID is OPTIONAL; skip only a DIFFERENT session's error — a
          // session-less one (id undefined) during our in-flight turn must still complete it, else
          // the surfaced batch is never acked and `busy` stays stuck.
          if (event.properties.sessionID && !ours(event.properties.sessionID)) return;
          if (!awaitingTurnEnd) return; // no in-flight turn to fail
          awaitingTurnEnd = false;
          busy = false;
          ackSurfaced(); // turn surfaced the batch but failed — ack (don't retry-loop) and move on
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
