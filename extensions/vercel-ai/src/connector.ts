import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { Connector, LaunchOpts, LaunchSpec } from "@swarl/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN = join(__dirname, "main.ts");

function buildLaunch(opts: LaunchOpts): LaunchSpec {
  const env: Record<string, string> = {
    SWARL_SPACE: opts.space,
    SWARL_NAME: opts.name,
  };
  if (opts.role) env.SWARL_ROLE = opts.role;
  if (opts.servers) env.SWARL_SERVERS = opts.servers;
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_MODEL) env.OPENAI_MODEL = process.env.OPENAI_MODEL;
  return { command: "tsx", args: [MAIN], env };
}

export const vercelAiConnector: Connector = {
  kind: "connector",
  name: "vercel-ai",
  buildLaunch,
};
