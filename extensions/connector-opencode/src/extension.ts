import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** The bundled in-process plugin (esbuild → `dist/plugin.bundle.js`). opencode loads it by
 *  absolute path from the inline config, so it runs *inside* the session process and shares its
 *  SDK client. Resolved relative to this module — beside the built `dist/extension.js`, so the
 *  connector must be built+bundled (`pnpm build`). */
const PLUGIN_ENTRY = fileURLToPath(new URL("./plugin.bundle.js", import.meta.url));

/** The launcher shim (`dist/serve.js`): starts `opencode serve` on a free port and pokes it once
 *  so the lazily-loaded plugin (and the mesh join) initialize without a client. */
const SERVE_SHIM = fileURLToPath(new URL("./serve.js", import.meta.url));

/**
 * The OpenCode connector: launches `opencode serve` (headless) with the Cotal mesh bridge loaded
 * as an in-process plugin via inline config, so the session joins the mesh and can be driven live.
 * Unlike Codex (pull-only) and Claude Code (channel nudge), OpenCode is client/server: the plugin
 * holds the {@link MeshAgent}, registers the cotal_* tools natively (from the shared specs, at
 * parity with Claude/Codex), reports presence off the event bus, and surfaces incoming peer
 * messages into the session over the SDK.
 *
 * Config rides in `OPENCODE_CONFIG_CONTENT` (inline JSON, the highest merge layer), so the
 * operator's `~/.config/opencode` is never written — the Codex `-c` trick in JSON.
 * `permission:"allow"` keeps a supervised, human-less session from deadlocking, since `opencode
 * serve` does NOT auto-approve (an "ask" permission hangs forever with no client attached); the
 * serve shim gates the server with a per-launch password (see serve.ts). Self-registers on import;
 * the manager resolves it by type "opencode".
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
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path; // plugin reads persona + model from it
      const def = loadAgentFile(path);
      if (def.model) env.COTAL_OPENCODE_MODEL = def.model; // also the wake prompt's model
    }

    const config = {
      $schema: "https://opencode.ai/config.json",
      permission: "allow",
      plugin: [PLUGIN_ENTRY],
    };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    // Run `opencode serve` through the shim (node dist/serve.js) so the lazily-loaded plugin is
    // woken at launch. The shim picks a free port; override with COTAL_OPENCODE_PORT.
    return {
      command: process.execPath,
      args: [SERVE_SHIM],
      env,
    };
  },
};

registry.register(opencodeConnector);
