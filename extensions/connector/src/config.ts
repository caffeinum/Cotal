// Moved into @swarl/core so every adapter (this MCP bridge, the OpenAI/Vercel
// embedded peers) shares one definition. Re-exported here for back-compat.
export { configFromEnv } from "@swarl/core";
export type { AgentConfig } from "@swarl/core";
