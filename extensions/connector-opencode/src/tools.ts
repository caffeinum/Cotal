/**
 * The Cotal tool surface for OpenCode, rendered from the **shared** {@link cotalToolSpecs}
 * (the same source the Claude Code / Codex MCP connectors render) as OpenCode-native plugin
 * tools (the `tool()` helper). One source of truth → the cotal_* surface can't drift across
 * adapters: an OpenCode peer gets the same tools (incl. channels / join / leave / channel_info).
 *
 * The one OpenCode-specific tool is `cotal_inbox`: this connector DRIVES delivery (it surfaces
 * each batch into a turn and acks on completion), so the agent's inbox tool is READ-ONLY — it
 * peeks (never drains), or it would race the connector's ack. It still honors focus-mode recall.
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { cotalToolSpecs, type MeshAgent, type AgentConfig } from "@cotal-ai/connector-core";

/** Build the cotal_* tool map wired to one mesh agent, rendered from the shared specs. */
export function buildCotalTools(agent: MeshAgent, config: AgentConfig): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {};
  for (const spec of cotalToolSpecs(config, "opencode")) {
    if (spec.name === "cotal_inbox") {
      // Read-only: this connector delivers + acks each turn, so the tool must never drain. Force
      // peek (still surfaces focus-mode recall), and reframe push-primary / pull-secondary. (norman)
      tools.cotal_inbox = tool({
        description:
          "Show the peer messages currently waiting for you (incl. focus-mode recall). You don't normally need this — the connector delivers peer messages into your turns automatically; use it to re-check what's pending mid-task. Read-only: it never consumes them.",
        args: {},
        async execute() {
          const r = await spec.run(agent, config, { peek: true });
          return r.isError ? `⚠ ${r.text}` : r.text;
        },
      });
      continue;
    }
    tools[spec.name] = tool({
      description: spec.description,
      // The shared spec carries a Zod raw shape; OpenCode's tool() takes the same (zod via tool.schema).
      args: (spec.schema ?? {}) as Record<string, never>,
      async execute(args: unknown) {
        const r = await spec.run(agent, config, (args ?? {}) as any);
        return r.isError ? `⚠ ${r.text}` : r.text;
      },
    });
  }
  return tools;
}
