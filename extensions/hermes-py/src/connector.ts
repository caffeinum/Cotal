import { fileURLToPath } from "node:url";
import type { Connector, LaunchOpts, LaunchSpec } from "@swarl/core";

/** Absolute path to THIS extension dir (where pyproject.toml lives). `uv run
 *  --project <dir>` makes the spawn cwd-independent, so the manager can launch it
 *  from anywhere. */
const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Provider keys forwarded to the peer if present. Hermes is model-agnostic; the
 *  default path is OpenRouter, but any of these unlocks a provider without lock-in. */
const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "NOUS_API_KEY",
];

/**
 * Launches a Hermes (Nous Research) agent as a Swarl mesh node via uv. The Python
 * peer (`swarl_hermes.peer`) reads its identity from `SWARL_*`, embeds Hermes'
 * `AIAgent`, and joins the mesh directly over NATS. Registered at a composition
 * root; the manager resolves it by agent type "hermes-py".
 */
export const hermesConnector: Connector = {
  kind: "connector",
  name: "hermes-py",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = {
      SWARL_SPACE: opts.space,
      SWARL_NAME: opts.name,
    };
    if (opts.role) env.SWARL_ROLE = opts.role;
    if (opts.servers) env.SWARL_SERVERS = opts.servers;
    if (process.env.HERMES_MODEL) env.HERMES_MODEL = process.env.HERMES_MODEL;
    for (const key of PROVIDER_KEYS) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    return {
      command: "uv",
      args: ["run", "--project", PROJECT_DIR, "python", "-m", "swarl_hermes.peer"],
      env,
    };
  },
};
