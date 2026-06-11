/**
 * MCP renderer for the Cotal tool surface.
 *
 * The tools themselves are defined once, platform-neutrally, in {@link cotalToolSpecs}
 * ({@link ./tool-specs.ts}); this just renders each onto an {@link McpServer}. Both the
 * Claude Code and Codex connectors build their own server (with platform-specific
 * capabilities) and call {@link registerCotalTools}. The OpenCode connector renders the
 * same specs as native plugin tools — so the surface stays identical across adapters.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cotalToolSpecs, type ToolResult } from "./tool-specs.js";
import type { MeshAgent } from "./agent.js";
import type { AgentConfig } from "./config.js";

function toContent(r: ToolResult) {
  const content = [{ type: "text" as const, text: r.text }];
  return r.isError ? { content, isError: true as const } : { content };
}

/** Register the Cotal tool surface (roster, inbox, send, dm, anycast, status, channels,
 *  channel_info, join, leave, spawn) on an MCP server. */
export function registerCotalTools(server: McpServer, agent: MeshAgent, config: AgentConfig): void {
  for (const spec of cotalToolSpecs(config)) {
    if (spec.schema) {
      server.registerTool(
        spec.name,
        { title: spec.title, description: spec.description, inputSchema: spec.schema },
        async (args: Record<string, unknown>) => toContent(await spec.run(agent, config, args)),
      );
    } else {
      server.registerTool(
        spec.name,
        { title: spec.title, description: spec.description },
        async () => toContent(await spec.run(agent, config, {})),
      );
    }
  }
}
