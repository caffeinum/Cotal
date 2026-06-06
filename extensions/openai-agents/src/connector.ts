import { fileURLToPath } from "node:url";
import type { Connector, LaunchOpts, LaunchSpec } from "@swarl/core";

export const openaiAgentsConnector: Connector = {
  kind: "connector",
  name: "openai-agents",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
    const env: Record<string, string> = {
      SWARL_SPACE: opts.space,
      SWARL_NAME: opts.name,
    };
    if (opts.role) env.SWARL_ROLE = opts.role;
    if (opts.servers) env.SWARL_SERVERS = opts.servers;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_MODEL) env.OPENAI_MODEL = process.env.OPENAI_MODEL;
    return { command: "tsx", args: [mainPath], env };
  },
};
