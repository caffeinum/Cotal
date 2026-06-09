import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** The launcher (run via tsx, which loads both) owns the mesh endpoint and supervises the Hermes
 *  gateway as a child — see launch.ts. Resolve `.ts` when this module loads from source (dev) and
 *  `.js` when it loads from the build: the package's `import` resolves to dist/, so a hardcoded
 *  `./launch.ts` would point at a file tsc never emits. */
const ENTRY_EXT = import.meta.url.includes("/dist/") ? "js" : "ts";
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const LAUNCH_ENTRY = fileURLToPath(new URL(`./launch.${ENTRY_EXT}`, import.meta.url));

/** Provider keys forwarded to the Hermes gateway if present. Hermes is model-agnostic; any one
 *  of these unlocks a provider. We forward, never require — the operator's own keys, untouched. */
const PROVIDER_KEYS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NOUS_API_KEY"];

/**
 * The Hermes (Nous Research) connector. Unlike Claude Code / Codex — where the harness *is* the
 * process and an MCP server rides inside it — Hermes runs as a long-lived **gateway daemon** that
 * spins up a fresh `AIAgent` per inbound message. So the mesh endpoint can't live inside a
 * per-turn MCP server; it must outlive every turn. The connector's command is therefore a small
 * **launcher/supervisor** (`launch.ts`) that owns the {@link MeshAgent} for the gateway's whole
 * life, bridges to an in-gateway Python plugin (adapter + hooks + tools) over two local sockets,
 * and spawns `hermes gateway run` as its child. Self-registers on import; the manager resolves it
 * by agent type "hermes".
 */
export const hermesConnector: Connector = {
  kind: "connector",
  name: "hermes",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = { COTAL_SPACE: opts.space, COTAL_NAME: opts.name };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    // An agent file carries identity + persona + model; the launcher applies the persona as
    // Hermes' SOUL.md (system prompt) at gateway startup, the one place it can be set.
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    if (process.env.HERMES_MODEL) env.HERMES_MODEL = process.env.HERMES_MODEL;
    for (const k of PROVIDER_KEYS) if (process.env[k]) env[k] = process.env[k]!;
    return { command: TSX, args: [LAUNCH_ENTRY], env };
  },
};

registry.register(hermesConnector);
