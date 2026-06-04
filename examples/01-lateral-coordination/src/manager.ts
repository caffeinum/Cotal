/**
 * Composition root for Demo 1. This is where extensions plug in: it builds the
 * registry, explicitly registers the connectors this demo wants (the built-in
 * `swarl` peer plus the Claude Code connector), and starts a manager over them.
 * The manager and core stay ignorant of which connectors exist — the example picks.
 */
import { DEFAULT_SERVER, isReachable, Registry } from "@swarl/core";
import { Manager } from "@swarl/manager";
import { swarlConnector } from "@swarl/cli/connector";
import { claudeConnector } from "@swarl/connector";

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
