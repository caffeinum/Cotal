/**
 * Composition root for example 03 (OpenAI Agents JS). Runs a manager that spawns
 * OpenAI-Agents-SDK peers into the space as detached processes. Each spawn is a real
 * agent loop (extensions/openai-agents) that embeds a Swarl endpoint and answers DMs,
 * anycasts, and @-mentions on channels.
 */
import { DEFAULT_SERVER, isReachable, Registry } from "@swarl/core";
import type { Connector } from "@swarl/core";
import { Manager } from "@swarl/manager";
import { openaiAgentsConnector } from "@swarl/openai-agents";

const space = process.env.SWARL_SPACE?.trim() || "demo";
const server = process.env.SWARL_SERVERS?.trim() || DEFAULT_SERVER;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm swarl up`);
  process.exit(1);
}

const registry = new Registry();
registry.register(openaiAgentsConnector);
// Alias under "swarl" so a bare swarl_spawn(name, role) (agent type defaults to "swarl") routes here too.
const swarlAlias: Connector = {
  kind: "connector",
  name: "swarl",
  buildLaunch: openaiAgentsConnector.buildLaunch,
};
registry.register(swarlAlias);

const mgr = new Manager({ space, registry, servers: server, spawnMode: "detached" });
await mgr.start();
console.log(`example-03-openai-agents manager up in space "${space}" — spawn mode: detached`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
