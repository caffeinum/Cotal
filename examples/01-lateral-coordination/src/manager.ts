/**
 * Composition root for Demo 1. This is where the pieces are assembled: it builds
 * the registry, registers the connectors this demo wants (the built-in `swarl`
 * peer plus the Claude Code connector), and starts a manager over them. The
 * manager and core stay ignorant of which connectors exist — the example picks.
 */
import {
  DEFAULT_SERVER,
  isReachable,
  Registry,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
} from "@swarl/core";
import { Manager } from "@swarl/manager";
import { claudeConnector } from "@swarl/connector";

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

const space = process.env.SWARL_SPACE?.trim() || "demo";
const server = process.env.SWARL_SERVERS?.trim() || DEFAULT_SERVER;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm swarl up`);
  process.exit(1);
}

const registry = new Registry();
registry.register(swarlConnector);
registry.register(claudeConnector);

const mgr = new Manager({ space, registry, servers: server });
await mgr.start();
console.log(`example-01 manager up in space "${space}" — connectors: swarl, claude`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
