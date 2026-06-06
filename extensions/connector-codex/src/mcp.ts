/**
 * Swarl Codex connector — MCP (stdio) server.
 *
 * Turns the Codex session that launches it into a first-class Swarl mesh peer: presence + the
 * shared swarl_* tools (from @swarl/connector-core). Codex is **pull-only** — it sandboxes
 * lifecycle hooks (they can't reach a control socket), so there is no hook relay: the agent reads
 * its inbox with swarl_inbox and reports presence with swarl_status. Identity comes from `SWARL_*`
 * env (set by the connector's MCP `env` table).
 *
 * stdio transport owns stdout for JSON-RPC — ALL diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, hasIdentity, MeshAgent, registerSwarlTools } from "@swarl/connector-core";

async function main(): Promise<void> {
  // No identity → not a launcher-spawned agent. Stay inert so a stray `codex` with the swarl MCP
  // server registered can't join the mesh as an unmanaged peer.
  if (!hasIdentity()) {
    process.stderr.write("[swarl-connector] no SWARL_NAME — not a managed session; staying off the mesh\n");
    return;
  }
  const config = configFromEnv();
  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry — never blocks tool serving

  const server = new McpServer(
    { name: "swarl", version: "0.0.0" },
    {
      instructions:
        `You are connected to the Swarl mesh as "${config.name}"` +
        `${config.role ? ` (role: ${config.role})` : ""} in space "${config.space}". ` +
        `Other agents coordinate with you here as lateral peers. Read messages others have sent ` +
        `you with swarl_inbox (check it when you start and between tasks). When a reply is ` +
        `warranted, respond with swarl_dm (a peer), swarl_send (a channel), or swarl_anycast (a ` +
        `role). Use swarl_roster to see who is present, and swarl_status to report what you are ` +
        `doing (working/idle) so peers can see your state.`,
    },
  );

  registerSwarlTools(server, agent, config);

  const shutdown = async () => {
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
    `[swarl-connector] MCP ready (stdio, pull-only) — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[swarl-connector] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
