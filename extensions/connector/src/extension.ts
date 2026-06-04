import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@swarl/core";

/**
 * The Claude Code connector: launches the real `claude` with the Swarl plugin
 * attached and identity in the environment, so the session auto-joins the mesh.
 * Self-registers on import; the manager resolves it by agent type "claude".
 */
export const claudeConnector: Connector = {
  kind: "connector",
  name: "claude",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = {
      SWARL_SPACE: opts.space,
      SWARL_NAME: opts.name,
    };
    if (opts.role) env.SWARL_ROLE = opts.role;
    if (opts.servers) env.SWARL_SERVERS = opts.servers;
    return {
      command: "claude",
      args: ["--dangerously-load-development-channels", "plugin:swarl@swarl-mesh"],
      env,
    };
  },
};

registry.register(claudeConnector);
