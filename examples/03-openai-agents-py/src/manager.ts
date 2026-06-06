/**
 * Composition root for example 03 (OpenAI Agents SDK — Python). Runs a manager that
 * spawns Python peers (extensions/openai-agents-py) as detached processes via uv. Each
 * peer embeds a Python Swarl wire client and answers DMs, anycasts, and @-mentions on
 * channels — interoperating on the wire with the TypeScript peers.
 */
import { DEFAULT_SERVER, isReachable, Registry } from "@swarl/core";
import type { Connector } from "@swarl/core";
import { Manager } from "@swarl/manager";
import { openaiAgentsPyConnector } from "@swarl/openai-agents-py";

const space = process.env.SWARL_SPACE?.trim() || "demo";
const server = process.env.SWARL_SERVERS?.trim() || DEFAULT_SERVER;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm swarl up`);
  process.exit(1);
}

const registry = new Registry();
registry.register(openaiAgentsPyConnector);
// Alias under "swarl" so a bare swarl_spawn(name, role) (agent type defaults to "swarl") routes here too.
const swarlAlias: Connector = {
  kind: "connector",
  name: "swarl",
  buildLaunch: openaiAgentsPyConnector.buildLaunch,
};
registry.register(swarlAlias);

const mgr = new Manager({ space, registry, servers: server, spawnMode: "detached" });
await mgr.start();
console.log(`example-03-openai-agents-py manager up in space "${space}" — spawn mode: detached`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
