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
        // Now idle: if ambient channel chatter was held while we were busy, ask the channel to
        // wake one turn so its UserPromptSubmit drains+acks the batch (the sole ack site). Stop
        // can't inject context itself, so we must NOT drain here — that would ack with no vehicle
        // to the model and silently lose the messages.
        if (agent.inboxCount() > 0) agent.requestWake();
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

  // One wake-nudge path, shared by incoming messages and the Stop→idle flush. It stays a stable
  // function gated on a *mutable* `channelActive` flag (flipped true only after the MCP
  // handshake confirms the client speaks claude/channel — see below). If it fires before then it
  // simply no-ops; the message waits unacked in the inbox and is drained at the next
  // UserPromptSubmit, so nothing is lost. This only ever *wakes* a turn — drainInbox stays the
  // sole ack site.
  let channelActive = false;
  const nudge = (item?: InboxItem): void => {
    if (!channelActive) return;
    const n = agent.inboxCount();
    const content = item
      ? `📨 New ${item.kind}${item.mentionsMe ? " — you were mentioned" : ""} from ${fmtFrom(item)} — delivering your Swarl inbox now.`
      : `📨 ${n} Swarl message${n === 1 ? "" : "s"} waiting — delivering your inbox now.`;
    void server.server
      .notification({
        method: "notifications/claude/channel",
        params: { content, meta: item ? channelMeta(item) : { kind: "batch" } },
      })
      .catch((e) => process.stderr.write(`[swarl-connector] channel nudge failed: ${(e as Error).message}\n`));
  };

  // Two priority tiers. A *directed* message (DM, anycast, or an @mention of us) always nudges,
  // so the addressee sees it promptly — woken now if idle, at the next turn boundary if busy.
  // *Ambient* channel chatter (not addressed to us) is suppressed while we're mid-turn ("working")
  // and instead accumulates in the inbox; the Stop→idle flush then fires one batch nudge.
  agent.on("incoming", (item: InboxItem) => {
    const ambient = item.kind === "channel" && !item.mentionsMe && agent.status === "working";
    if (!ambient) nudge(item);
  });
  agent.on("wake", () => nudge());

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

  // Is this session consuming us as a channel? Only now (post-handshake) can we read the
  // client's capabilities, so we flip the mutable flag the nudge path is gated on. The handlers
  // were registered above and simply no-op'd until this point.
  const clientCaps = server.server.getClientCapabilities();
  const envFlag = process.env.SWARL_CHANNEL;
  channelActive = envFlag
    ? /^(1|true|yes|on)$/i.test(envFlag)
    : Boolean((clientCaps?.experimental as Record<string, unknown> | undefined)?.["claude/channel"]);
  process.stderr.write(
    `[swarl-connector] client capabilities: ${JSON.stringify(clientCaps ?? {})} → channel ${channelActive ? "ACTIVE" : "off"}\n`,
  );

  process.stderr.write(
    `[swarl-connector] MCP ready (stdio) — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[swarl-connector] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
