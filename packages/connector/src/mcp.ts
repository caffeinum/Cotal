/**
 * Swarl connector — MCP (stdio) server.
 *
 * Turns the Claude Code session that launches it into a first-class Swarl mesh
 * peer: it holds presence and exposes tools to read its inbox, broadcast, DM a
 * peer, address a role, and report status. Identity comes from `SWARL_*` env.
 *
 * stdio transport owns stdout for JSON-RPC — ALL diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { PresenceStatus } from "@swarl/core";
import { configFromEnv } from "./config.js";
import { MeshAgent, type InboxItem } from "./agent.js";
import { startControlServer } from "./control.js";
import { controlSocketPath } from "./runtime.js";

function statusGlyph(s: PresenceStatus): string {
  return s === "working" ? "●" : s === "waiting" ? "◐" : s === "idle" ? "○" : "·";
}

function fmtFrom(i: InboxItem): string {
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
function channelMeta(i: InboxItem): Record<string, string> {
  const m: Record<string, string> = { kind: i.kind, from: i.fromName, from_id: i.fromId };
  if (i.fromRole) m.role = i.fromRole;
  if (i.channel) m.channel = i.channel;
  if (i.service) m.to_role = i.service; // anycast: the role that was addressed
  return m;
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry — never blocks tool serving

  // Local control plane for the lifecycle hooks (presence + message injection).
  const socketPath = controlSocketPath(config.space, config.name);
  const controlServer = startControlServer(agent, socketPath);

  const server = new McpServer(
    { name: "swarl", version: "0.0.0" },
    {
      // `claude/channel` makes this MCP server a Claude Code *channel*: peer
      // messages can be pushed straight into the session (waking it if idle).
      capabilities: { experimental: { "claude/channel": {} } },
      instructions:
        `You are connected to the Swarl mesh as "${config.name}"` +
        `${config.role ? ` (role: ${config.role})` : ""} in space "${config.space}". ` +
        `Other agents coordinate with you here as lateral peers. ` +
        `Peer messages may arrive as <channel source="swarl" from="<name>" role="<role>" ` +
        `kind="dm|channel|anycast" channel="<name>">…</channel> — read them and, when a reply is ` +
        `warranted, respond with swarl_dm (back to that peer), swarl_send (to a channel), or ` +
        `swarl_anycast (to a role). Use swarl_roster to see who is present, swarl_inbox to pull ` +
        `anything you may have missed, and swarl_status to report what you are doing.`,
    },
  );

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

  const shutdown = async () => {
    try {
      controlServer.close();
    } catch {
      /* ignore */
    }
    try {
      await agent.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Is this session consuming us as a channel? If so, a peer message fires a *wake nudge*
  // so an idle session takes a turn now — its UserPromptSubmit hook then drains + acks the
  // inbox (the single authoritative delivery path). The nudge itself never acks/removes, so
  // nothing is lost if the channel is inactive; the message waits in the stream for the next turn.
  const clientCaps = server.server.getClientCapabilities();
  const envFlag = process.env.SWARL_CHANNEL;
  const channelActive = envFlag
    ? /^(1|true|yes|on)$/i.test(envFlag)
    : Boolean((clientCaps?.experimental as Record<string, unknown> | undefined)?.["claude/channel"]);
  process.stderr.write(
    `[swarl-connector] client capabilities: ${JSON.stringify(clientCaps ?? {})} → channel ${channelActive ? "ACTIVE" : "off"}\n`,
  );

  if (channelActive) {
    agent.on("incoming", (item: InboxItem) => {
      void server.server
        .notification({
          method: "notifications/claude/channel",
          params: {
            content: `📨 New ${item.kind} from ${fmtFrom(item)} — delivering your Swarl inbox now.`,
            meta: channelMeta(item),
          },
        })
        .catch((e) =>
          process.stderr.write(`[swarl-connector] channel nudge failed: ${(e as Error).message}\n`),
        );
    });
  }

  process.stderr.write(
    `[swarl-connector] MCP ready (stdio) — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[swarl-connector] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
