import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@swarl/core";

/** Channel ref for the locally-installed `swarl` plugin (marketplace `swarl-mesh`).
 *  `--dangerously-load-development-channels <ref>` turns on the plugin's
 *  `claude/channel` capability so an idle session wakes the instant a peer message
 *  arrives. The plugin must be *installed* (not `--plugin-dir`) for the channel to
 *  bind; the connector's identity guard keeps it inert in non-managed sessions. */
const CHANNEL_REF = "plugin:swarl@swarl-mesh";

/**
 * The Claude Code connector: launches the real `claude` with the Swarl identity in
 * the environment and the mesh channel enabled, so the session joins the mesh and
 * wakes on incoming peer messages. Self-registers on import; the manager resolves it
 * by agent type "claude".
 */
export const claudeConnector: Connector = {
  kind: "connector",
  name: "claude",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = {
      SWARL_SPACE: opts.space,
      SWARL_NAME: opts.name,
      // Force the connector to emit channel wake-nudges: Claude doesn't advertise the
      // `claude/channel` capability back over MCP, so auto-detection would see it "off".
      SWARL_CHANNEL: "1",
    };
    if (opts.role) env.SWARL_ROLE = opts.role;
    if (opts.servers) env.SWARL_SERVERS = opts.servers;
    return {
      command: "claude",
      args: ["--dangerously-load-development-channels", CHANNEL_REF],
      env,
      // The dev-channels flag shows a one-time "Enter to confirm" prompt; the
      // manager auto-clears it so a supervised launch needs no human keypress.
      confirm: "Enter to confirm",
    };
  },
};

registry.register(claudeConnector);
