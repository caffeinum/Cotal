/**
 * Composition root for example 03 (Vercel AI SDK). Runs a manager that spawns
 * Vercel-AI-SDK peers into the space. Each spawn is a real agent loop
 * (extensions/vercel-ai) that embeds a Swarl endpoint and answers DMs, anycasts,
 * and @-mentions on channels via generateText + tool calls. Importing the connector
 * self-registers it as "vercel-ai"; we also alias it under "swarl" so a bare
 * `swarl start --name x` (the default agent type) spawns one too.
 */
import { DEFAULT_SERVER, isReachable, registry, type Connector } from "@swarl/core";
import { Manager } from "@swarl/manager";
import { vercelAiConnector } from "@swarl/vercel-ai"; // self-registers "vercel-ai"

const swarlAlias: Connector = {
  kind: "connector",
  name: "swarl",
  buildLaunch: vercelAiConnector.buildLaunch,
};
registry.register(swarlAlias);

const space = process.env.SWARL_SPACE?.trim() || "demo";
const server = process.env.SWARL_SERVERS?.trim() || DEFAULT_SERVER;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm swarl up`);
  process.exit(1);
}

const mgr = new Manager({ space, servers: server });
await mgr.start();
console.log(`example-03-vercel-ai manager up in space "${space}" — connectors: vercel-ai, swarl`);
console.log(`console: ${mgr.consoleUrl}`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
