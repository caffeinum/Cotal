/**
 * The Cotal tool surface for OpenCode — the same six-plus-spawn tools the MCP
 * connectors expose (from @cotal-ai/connector-core), re-expressed as OpenCode
 * *native* plugin tools. OpenCode plugins register model-callable tools directly
 * (the `tool()` helper, zod via `tool.schema`), so we wire them straight to the
 * in-process {@link MeshAgent} — no separate stdio MCP server, one mesh endpoint.
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { type PresenceStatus } from "@cotal-ai/core";
import { fmtFrom, type MeshAgent, type InboxItem, type AgentConfig } from "@cotal-ai/connector-core";

function statusGlyph(s: PresenceStatus): string {
  return s === "working" ? "●" : s === "waiting" ? "◐" : s === "idle" ? "○" : "·";
}

/** UI affordance tags (face-term's [[face:X]]) ride the tool ARGS for the local renderer —
 *  strip them from the mesh payload so peers and consoles see clean text. */
function stripFaceTags(s: string): string {
  return s.replace(/\[\[face:[a-z]+\]\]\s*/g, "").trim();
}

function fmtItem(i: InboxItem): string {
  if (i.kind === "dm") return `[DM from ${fmtFrom(i)}] ${i.text}`;
  if (i.kind === "anycast") return `[@${i.service} from ${fmtFrom(i)}] ${i.text}`;
  return `[#${i.channel}${i.mentionsMe ? " @you" : ""} ${fmtFrom(i)}] ${i.text}`;
}

/** Build the cotal_* tool map wired to one mesh agent. */
export function buildCotalTools(agent: MeshAgent, config: AgentConfig): Record<string, ToolDefinition> {
  const z = tool.schema;
  const defaultChannel = config.channels[0] ?? "general";
  return {
    cotal_roster: tool({
      description: "List the agents currently present in your Cotal space, with their role, status, and current activity.",
      args: {},
      async execute() {
        if (!agent.connected) return `Not connected to the mesh yet (${config.servers}).`;
        const roster = agent.roster();
        if (!roster.length) return `No one is present in "${config.space}" yet.`;
        const lines = roster.map((p) => {
          const who = p.card.role ? `${p.card.name}/${p.card.role}` : p.card.name;
          const me = p.card.id === agent.id ? " (you)" : "";
          return `${statusGlyph(p.status)} ${who} — ${p.status}${p.activity ? `: ${p.activity}` : ""}${me}`;
        });
        return `Present in "${config.space}" (${roster.length}):\n${lines.join("\n")}`;
      },
    }),

    cotal_inbox: tool({
      description:
        "Show the peer messages currently waiting for you — channel broadcasts, direct messages, and role requests. Read-only: the connector delivers and acks them for you on each turn, so this never consumes them.",
      args: {},
      async execute() {
        const items = agent.peekInbox();
        if (!items.length) return "Inbox empty — no waiting messages.";
        return `${items.length} message${items.length === 1 ? "" : "s"} waiting:\n${items.map(fmtItem).join("\n")}`;
      },
    }),

    cotal_send: tool({
      description: "Broadcast a message to everyone on a channel in your space.",
      args: {
        text: z.string().describe("The message to broadcast."),
        channel: z.string().optional().describe(`Channel to send on (default: ${defaultChannel}). Concrete only — reply on the channel you received a message on.`),
        mentions: z
          .array(z.string())
          .optional()
          .describe(
            "Names of peers to call out (e.g. ['bob']). A mentioned peer gets high-priority delivery — woken now if idle. Use sparingly: a mention WAKES that peer, so never mention in an acknowledgement or sign-off, or peers ping-pong wake-ups in a loop.",
          ),
      },
      async execute({ text, channel, mentions }) {
        const m = await agent.send(stripFaceTags(text), channel, mentions);
        return `Sent to #${m.channel}${m.mentions?.length ? ` (mentioned @${m.mentions.join(", @")})` : ""}.`;
      },
    }),

    cotal_dm: tool({
      description: "Send a private message to one specific peer, by name (or instance id).",
      args: { to: z.string().describe("The peer's name (or instance id)."), text: z.string().describe("The message.") },
      async execute({ to, text }) {
        const { peer } = await agent.dm(to, stripFaceTags(text));
        return `DM sent to ${peer.card.name}.`;
      },
    }),

    cotal_anycast: tool({
      description:
        "Send a request to ANY one available agent of a given role (load-balanced). Use when you need 'a reviewer' rather than a specific person.",
      args: { role: z.string().describe("The role to address (e.g. reviewer)."), text: z.string().describe("The request.") },
      async execute({ role, text }) {
        await agent.anycast(role, stripFaceTags(text));
        return `Sent to one @${role}.`;
      },
    }),

    cotal_status: tool({
      description: "Set your presence status and activity so peers can see what you are doing.",
      args: {
        status: z.enum(["idle", "working", "waiting"]).describe("idle = free; working = busy on a task; waiting = blocked on input, approval, or a peer."),
        activity: z.string().optional().describe("Short note on what you're doing right now."),
      },
      async execute({ status, activity }) {
        await agent.setStatus(status, activity);
        return `You are now ${status}${activity ? `: ${activity}` : ""}.`;
      },
    }),

    cotal_spawn: tool({
      description:
        "Ask the manager to start a new peer endpoint in your space. It joins the mesh as a lateral peer. Use when the team needs another agent.",
      args: { name: z.string().describe("Unique name for the new peer."), role: z.string().optional().describe("Optional role (e.g. worker, reviewer).") },
      async execute({ name, role }) {
        const reply = await agent.spawn(name, role);
        if (!reply.ok) return `Couldn't spawn ${name}: ${reply.error ?? "manager refused"}`;
        const mode = (reply.data as { mode?: string } | undefined)?.mode;
        return `Spawning ${role ? `${name}/${role}` : name}${mode ? ` (${mode})` : ""} — it will appear in the roster shortly.`;
      },
    }),
  };
}
