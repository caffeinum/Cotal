/**
 * The Swarl MCP tool surface — platform-agnostic.
 *
 * Lets a session read its inbox, broadcast, DM a peer, address a role, and report
 * status on the mesh. Both the Claude Code and Codex connectors build their own
 * McpServer (with platform-specific capabilities) and call {@link registerSwarlTools}
 * to add this shared surface.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PresenceStatus } from "@swarl/core";
import type { MeshAgent, InboxItem } from "./agent.js";
import type { AgentConfig } from "./config.js";

function statusGlyph(s: PresenceStatus): string {
  return s === "working" ? "●" : s === "waiting" ? "◐" : s === "idle" ? "○" : "·";
}

/** "name/role" (or just "name") for a message's sender. */
export function fmtFrom(i: InboxItem): string {
  return i.fromRole ? `${i.fromName}/${i.fromRole}` : i.fromName;
}

function fmtItem(i: InboxItem): string {
  if (i.kind === "dm") return `[DM from ${fmtFrom(i)}] ${i.text}`;
  if (i.kind === "anycast") return `[@${i.service} from ${fmtFrom(i)}] ${i.text}`;
  return `[#${i.channel} ${fmtFrom(i)}] ${i.text}`;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true as const });

/** Routing context for a `<channel …>` tag. Keys must be [A-Za-z0-9_] (others are dropped). */
export function channelMeta(i: InboxItem): Record<string, string> {
  const m: Record<string, string> = { kind: i.kind, from: i.fromName, from_id: i.fromId };
  if (i.fromRole) m.role = i.fromRole;
  if (i.channel) m.channel = i.channel;
  if (i.service) m.to_role = i.service; // anycast: the role that was addressed
  return m;
}

/** Register the six Swarl tools (roster, inbox, send, dm, anycast, status) on a server. */
export function registerSwarlTools(server: McpServer, agent: MeshAgent, config: AgentConfig): void {
  server.registerTool(
    "swarl_roster",
    {
      title: "Swarl: who's present",
      description:
        "List the agents currently present in your Swarl space, with their role, status, and current activity.",
    },
    async () => {
      if (!agent.connected) return text(`Not connected to the mesh yet (${config.servers}).`);
      const roster = agent.roster();
      if (!roster.length) return text(`No one is present in "${config.space}" yet.`);
      const lines = roster.map((p) => {
        const who = p.card.role ? `${p.card.name}/${p.card.role}` : p.card.name;
        const me = p.card.id === agent.id ? " (you)" : "";
        return `${statusGlyph(p.status)} ${who} — ${p.status}${p.activity ? `: ${p.activity}` : ""}${me}`;
      });
      return text(`Present in "${config.space}" (${roster.length}):\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "swarl_inbox",
    {
      title: "Swarl: read incoming messages",
      description:
        "Read messages other agents have sent you since you last checked — channel broadcasts, direct messages, and role requests. Clears them unless peek is true.",
      inputSchema: {
        peek: z.boolean().optional().describe("If true, show messages without clearing them."),
      },
    },
    async ({ peek }) => {
      const items = peek ? agent.peekInbox() : agent.drainInbox();
      if (!items.length) return text("Inbox empty — no new messages.");
      const head = `${items.length} message${items.length === 1 ? "" : "s"}${peek ? " (peek — not cleared)" : ""}:`;
      return text(`${head}\n${items.map(fmtItem).join("\n")}`);
    },
  );

  server.registerTool(
    "swarl_send",
    {
      title: "Swarl: broadcast to a channel",
      description: "Broadcast a message to everyone on a channel in your space.",
      inputSchema: {
        text: z.string().describe("The message to broadcast."),
        channel: z
          .string()
          .optional()
          .describe(`Channel to send on (default: ${config.channels[0]}).`),
      },
    },
    async ({ text: msg, channel }) => {
      try {
        const m = await agent.send(msg, channel);
        return text(`Sent to #${m.channel}.`);
      } catch (e) {
        return fail(`Couldn't send: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "swarl_dm",
    {
      title: "Swarl: direct-message a peer",
      description: "Send a private message to one specific peer, by name (or instance id).",
      inputSchema: {
        to: z.string().describe("The peer's name (or instance id)."),
        text: z.string().describe("The message."),
      },
    },
    async ({ to, text: msg }) => {
      try {
        const { peer } = await agent.dm(to, msg);
        return text(`DM sent to ${peer.card.name}.`);
      } catch (e) {
        return fail(`Couldn't DM: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "swarl_anycast",
    {
      title: "Swarl: ask any agent of a role",
      description:
        "Send a request to ANY one available agent of a given role (load-balanced). Use when you need 'a reviewer' rather than a specific person.",
      inputSchema: {
        role: z.string().describe("The role to address (e.g. reviewer)."),
        text: z.string().describe("The request."),
      },
    },
    async ({ role, text: msg }) => {
      try {
        await agent.anycast(role, msg);
        return text(`Sent to one @${role}.`);
      } catch (e) {
        return fail(`Couldn't send: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "swarl_status",
    {
      title: "Swarl: set your status",
      description: "Set your presence status and activity so peers can see what you are doing.",
      inputSchema: {
        status: z
          .enum(["idle", "working", "waiting"])
          .describe(
            "idle = free; working = busy on a task; waiting = blocked on input, approval, or a peer.",
          ),
        activity: z.string().optional().describe("Short note on what you're doing right now."),
      },
    },
    async ({ status, activity }) => {
      try {
        await agent.setStatus(status, activity);
        return text(`You are now ${status}${activity ? `: ${activity}` : ""}.`);
      } catch (e) {
        return fail(`Couldn't set status: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "swarl_spawn",
    {
      title: "Swarl: spawn a new teammate",
      description:
        "Ask the manager to start a new peer endpoint in your space. It joins the mesh as a lateral peer (and, when the manager runs the cmux runtime, appears in its own tab). Use when the team needs another agent.",
      inputSchema: {
        name: z.string().describe("Unique name for the new peer."),
        role: z
          .string()
          .optional()
          .describe("Optional role for the new peer (e.g. worker, reviewer)."),
      },
    },
    async ({ name, role }) => {
      try {
        const reply = await agent.spawn(name, role);
        if (!reply.ok) return fail(`Couldn't spawn ${name}: ${reply.error ?? "manager refused"}`);
        const mode = (reply.data as { mode?: string } | undefined)?.mode;
        return text(
          `Spawning ${role ? `${name}/${role}` : name}${mode ? ` (${mode})` : ""} — it will appear in the roster shortly.`,
        );
      } catch (e) {
        return fail(
          `Couldn't spawn ${name}: no manager reachable (${(e as Error).message}). Is the manager running?`,
        );
      }
    },
  );
}
