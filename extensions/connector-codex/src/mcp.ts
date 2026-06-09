/**
 * Cotal Codex connector — MCP (stdio) server + lifecycle-hook control plane.
 *
 * Turns the Codex session that launches it into a first-class Cotal mesh peer: the
 * shared cotal_* tools (from @cotal-ai/connector-core) for deliberate sends + inbox
 * pulls, AND lifecycle hooks that drive presence and inject waiting peer messages
 * into a turn. Codex's hooks framework mirrors Claude Code's, so the same control
 * socket + relay (control.ts / relay.ts) carry SessionStart / UserPromptSubmit /
 * PermissionRequest / Stop here too. Identity comes from `COTAL_*` env.
 *
 * Codex has no `claude/channel` analog, so this can't wake an idle TUI mid-idle —
 * the inbox is injected at the next turn boundary (UserPromptSubmit). For true
 * wake/steer of a live session, see the host-mode app-server driver (host.ts).
 *
 * stdio transport owns stdout for JSON-RPC — ALL diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  configFromEnv,
  hasIdentity,
  laneLine,
  MeshAgent,
  registerCotalTools,
  controlSocketPath,
  startControlServer,
  formatInjection,
  type HookHandle,
} from "@cotal-ai/connector-core";

/**
 * Codex lifecycle events → presence + (on inject-capable events) the waiting inbox.
 * Codex sends `hook_event_name` per its hooks framework; we normalise case and echo the
 * original name back in `hookSpecificOutput.hookEventName`. Mirrors the Claude handler,
 * minus the channel nudge (Codex has no push) — held messages drain at the next turn.
 */
const codexHandle: HookHandle = async (agent, ev) => {
  const raw = typeof ev.hook_event_name === "string" ? ev.hook_event_name : "";
  const withContext = (text?: string): Record<string, unknown> =>
    text ? { hookSpecificOutput: { hookEventName: raw, additionalContext: text } } : {};
  try {
    switch (raw.toLowerCase()) {
      case "sessionstart":
        await agent.setStatus("idle");
        return withContext(formatInjection(agent.drainInbox()));
      case "userpromptsubmit":
        await agent.setStatus("working");
        return withContext(formatInjection(agent.drainInbox()));
      case "permissionrequest": {
        // Blocked awaiting approval — surface what it's waiting on (the command) as the activity.
        const ti = ev.tool_input as Record<string, unknown> | undefined;
        const cmd = ti && typeof ti.command === "string" ? ti.command : undefined;
        const name = typeof ev.tool_name === "string" ? ev.tool_name : undefined;
        await agent.setStatus("waiting", name ? `${name}${cmd ? `: ${cmd}` : ""}` : undefined);
        return {};
      }
      case "stop":
        await agent.setStatus("idle");
        return {}; // no channel nudge on Codex; the inbox drains at the next UserPromptSubmit
      default:
        return {};
    }
  } catch {
    return {}; // never block the session
  }
};

async function main(): Promise<void> {
  // No identity → not a launcher-spawned agent. Stay inert so a stray `codex` with the cotal MCP
  // server registered can't join the mesh as an unmanaged peer.
  if (!hasIdentity()) {
    process.stderr.write("[cotal-connector] no COTAL_NAME — not a managed session; staying off the mesh\n");
    return;
  }
  const config = configFromEnv();
  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry — never blocks tool serving

  // Local control plane for the lifecycle hooks (presence + message injection).
  const socketPath = controlSocketPath(config.space, config.name);
  const controlServer = startControlServer(agent, socketPath, codexHandle);

  const server = new McpServer(
    { name: "cotal", version: "0.0.0" },
    {
      instructions:
        `You are connected to the Cotal mesh as "${config.name}"` +
        `${config.role ? ` (role: ${config.role})` : ""} in space "${config.space}". ` +
        laneLine(config) +
        `Other agents coordinate with you here as lateral peers. Waiting peer messages are injected ` +
        `into your turn automatically; you can also pull them with cotal_inbox. When a reply is ` +
        `warranted, respond with cotal_dm (a peer), cotal_send (a channel), or cotal_anycast (a ` +
        `role). Use cotal_roster to see who is present, and cotal_status to report what you are ` +
        `doing. No need to reply in a channel if not addressed directly, unless you have something ` +
        `worthwhile to add; no need for courtesy and politeness in your responses.`,
    },
  );

  registerCotalTools(server, agent, config);

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

  process.stderr.write(
    `[cotal-connector] MCP ready (stdio, hooks) — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[cotal-connector] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
