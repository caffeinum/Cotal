import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** The bundled in-process plugin (esbuild → `dist/plugin.bundle.js`). opencode loads it by
 *  absolute path from the inline config, so it runs *inside* the TUI's embedded server and shares
 *  its SDK client. Resolved relative to this module — beside the built `dist/extension.js`, so the
 *  connector must be built+bundled (`pnpm build`). */
const PLUGIN_ENTRY = fileURLToPath(new URL("./plugin.bundle.js", import.meta.url));

/**
 * The OpenCode connector: launches the real `opencode` TUI (foreground, watchable — like the
 * Claude Code connector launches `claude`) with the Cotal mesh bridge loaded as an in-process
 * plugin via inline config. The plugin holds the {@link MeshAgent}, registers the cotal_* tools
 * natively (from the shared specs, at parity with Claude/Codex), reports presence off the event
 * bus, and drives the *visible* session — it injects each incoming peer batch as a turn via the
 * TUI prompt (clear → append → submit), so a human watching the TUI sees the agent work and can
 * type into the same session.
 *
 * Config rides in `OPENCODE_CONFIG_CONTENT` (inline JSON, the highest merge layer), so the
 * operator's `~/.config/opencode` is never written — the Codex `-c` trick in JSON.
 * `permission:"allow"` keeps a supervised agent from stalling on a tool approval the human may not
 * be at the keyboard to grant. Self-registers on import; the manager resolves it by type "opencode".
 */
export const opencodeConnector: Connector = {
  kind: "connector",
  name: "opencode",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    // Identity rides the process env: the plugin runs in the opencode process and inherits it
    // (unlike the Codex/Claude MCP servers, which get none of the parent env).
    const env: Record<string, string> = { COTAL_SPACE: opts.space, COTAL_NAME: opts.name };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;

    const args: string[] = [];

    // An agent file carries identity (read in-session via COTAL_AGENT_FILE) plus persona + model.
    // The model is a launch flag (the TUI's default model is what `submitPrompt` runs); the persona
    // is applied in-session by the plugin (opencode has no `--append-system-prompt`).
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path; // plugin reads persona from it
      const def = loadAgentFile(path);
      if (def.model) args.push("--model", def.model);
    }

    const config = {
      $schema: "https://opencode.ai/config.json",
      permission: "allow",
      plugin: [PLUGIN_ENTRY],
    };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    // Launch the `opencode` TUI in the foreground. Override the binary with COTAL_OPENCODE_BIN.
    return {
      command: process.env.COTAL_OPENCODE_BIN?.trim() || "opencode",
      args,
      env,
    };
  },
};

registry.register(opencodeConnector);
