import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@swarl/core";

/** The peer loop runs straight from source via tsx (resolved from this extension's own
 *  node_modules, so it works regardless of the spawned process's PATH/cwd) — both paths
 *  resolved relative to this file. */
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

/**
 * The OpenAI Agents (TS) connector: launches an embedded Swarl peer that runs the
 * OpenAI Agents SDK loop and answers mesh traffic as a lateral peer. Forwards the
 * launcher's identity + minted creds so the peer authenticates as `id` under auth.
 * Self-registers on import; the manager resolves it by agent type "openai-agents".
 */
export const openaiAgentsConnector: Connector = {
  kind: "connector",
  name: "openai-agents",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = { SWARL_SPACE: opts.space, SWARL_NAME: opts.name };
    if (opts.role) env.SWARL_ROLE = opts.role;
    if (opts.id) env.SWARL_ID = opts.id;
    if (opts.creds) env.SWARL_CREDS = opts.creds;
    if (opts.servers) env.SWARL_SERVERS = opts.servers;
    if (opts.configPath) env.SWARL_AGENT_FILE = opts.configPath;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_MODEL) env.OPENAI_MODEL = process.env.OPENAI_MODEL;
    return { command: TSX, args: [MAIN], env };
  },
};

registry.register(openaiAgentsConnector);
