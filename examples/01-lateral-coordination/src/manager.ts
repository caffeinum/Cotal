/**
 * Composition root for Demo 1's manager daemon. It picks which connectors this
 * demo can spawn: the built-in `swarl` CLI peer (defined + registered here) plus
 * the Claude Code connector (self-registers when `@swarl/connector` is imported).
 * The manager resolves them from the registry — it never sees this list directly.
 */
import {
  DEFAULT_SERVER,
  isReachable,
  registry,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
} from "@swarl/core";
import { Manager } from "@swarl/manager";
import "@swarl/connector"; // self-registers the `claude` connector

/** The walking-skeleton peer: a manual CLI endpoint launched via `swarl join`. */
const swarlConnector: Connector = {
  kind: "connector",
  name: "swarl",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const args = ["swarl", "join", "--space", opts.space, "--name", opts.name];
    if (opts.role) args.push("--role", opts.role);
    if (opts.servers) args.push("--server", opts.servers);
    return { command: "pnpm", args };
  },
};
registry.register(swarlConnector);

const space = process.env.SWARL_SPACE?.trim() || "demo";
const server = process.env.SWARL_SERVERS?.trim() || DEFAULT_SERVER;
const consolePort = Number(process.env.SWARL_CONSOLE_PORT) || 7878;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm swarl up`);
  process.exit(1);
}

const mgr = new Manager({ space, servers: server, consolePort });
await mgr.start();
console.log(`example-01 manager up in space "${space}" — connectors: swarl, claude`);
console.log(`console: ${mgr.consoleUrl}`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
