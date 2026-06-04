import type { Connector, LaunchOpts, LaunchSpec } from "@swarl/core";

/**
 * The built-in walking-skeleton peer: a manual CLI endpoint launched via
 * `swarl join`. The manager resolves it by agent type "swarl".
 */
export const swarlConnector: Connector = {
  kind: "connector",
  name: "swarl",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const args = ["swarl", "join", "--space", opts.space, "--name", opts.name];
    if (opts.role) args.push("--role", opts.role);
    if (opts.servers) args.push("--server", opts.servers);
    return { command: "pnpm", args };
  },
};
