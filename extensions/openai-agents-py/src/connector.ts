import { fileURLToPath } from "node:url";
import type { Connector, LaunchOpts, LaunchSpec } from "@swarl/core";

/** Absolute path to THIS extension dir (where pyproject.toml lives). `uv run
 *  --project <dir>` makes the spawn cwd-independent, so the manager can launch it
 *  from anywhere. */
const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Launches an OpenAI Agents SDK (Python) agent as a Swarl mesh node via uv. The
 * Python peer (`swarl_py.peer`) reads its identity from `SWARL_*` and joins the
 * mesh directly over NATS. Registered at a composition root; the manager resolves
 * it by agent type "openai-agents-py".
 */
export const openaiAgentsPyConnector: Connector = {
  kind: "connector",
  name: "openai-agents-py",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = {
      SWARL_SPACE: opts.space,
      SWARL_NAME: opts.name,
    };
    if (opts.role) env.SWARL_ROLE = opts.role;
    if (opts.servers) env.SWARL_SERVERS = opts.servers;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_MODEL) env.OPENAI_MODEL = process.env.OPENAI_MODEL;
    return {
      command: "uv",
      args: ["run", "--project", PROJECT_DIR, "python", "-m", "swarl_py.peer"],
      env,
    };
  },
};
