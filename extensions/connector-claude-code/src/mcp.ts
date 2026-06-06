/**
 * Swarl Claude Code connector — MCP (stdio) server.
 *
 * Turns the Claude Code session that launches it into a first-class Swarl mesh
 * peer: presence + the shared swarl_* tools (from @swarl/connector-core), plus
 * Claude's `claude/channel` push so an idle session wakes the instant a peer
 * message arrives. Identity comes from `SWARL_*` env.
 *
 * stdio transport owns stdout for JSON-RPC — ALL diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  configFromEnv,
  hasIdentity,
  MeshAgent,
  controlSocketPath,
  startControlServer,
  registerSwarlTools,
  formatInjection,
  fmtFrom,
  channelMeta,
  type InboxItem,
  type HookHandle,
} from "@swarl/connector-core";

/** Claude Code lifecycle events → presence + (on inject-capable events) queued peer messages. */
const claudeHandle: HookHandle = async (agent, ev) => {
  const event = ev.hook_event_name ?? "";
  const withContext = (text: string | undefined): Record<string, unknown> =>
    text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
  try {
    switch (event) {
      case "SessionStart":
        await agent.setStatus("idle");
        return withContext(formatInjection(agent.drainInbox()));
      case "UserPromptSubmit":
        await agent.setStatus("working");
        return withContext(formatInjection(agent.drainInbox()));
      case "Notification":
        await agent.setStatus("waiting");
        return {};
      case "Stop":
      case "StopFailure": // turn died on an API error — Stop won't fire, so reset here too
        await agent.setStatus("idle");
        return {};
      case "SessionEnd":
        await agent.setStatus("offline");
        return {};
      default:
        return {};
    }
  } catch {
    return {}; // never block the session
  }
};

async function main(): Promise<void> {
  // No identity → this is a plain `claude`, not a launcher-spawned agent. Stay
  // inert: never connect to the mesh, so an installed plugin can't make the
  // operator's own sessions join as stray peers.
  if (!hasIdentity()) {
    process.stderr.write("[swarl-connector] no SWARL_NAME — not a managed session; staying off the mesh\n");
    return;
  }
  const config = configFromEnv();
  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry — never blocks tool serving

  // Local control plane for the lifecycle hooks (presence + message injection).
  const socketPath = controlSocketPath(config.space, config.name);
  const controlServer = startControlServer(agent, socketPath, claudeHandle);

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

  registerSwarlTools(server, agent, config);

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
