/**
 * Composition root for example 02. Runs a manager that spawns teammates into their
 * own cmux tabs — but unlike the built-in `swarl` peer (a bare `swarl join` node),
 * each spawn is a *real coder*: a role-aware connector launches `run-agent.sh <role>`,
 * which cd's into the role's repo and starts claude with its CLAUDE.md + swarl MCP/hooks.
 * Registered under name "swarl" so the orchestrator's `swarl_spawn(name, role)` routes here.
 */
import { DEFAULT_SERVER, isReachable, Registry } from "@swarl/core";
import type { Connector, LaunchOpts, LaunchSpec } from "@swarl/core";
import { Manager } from "@swarl/manager";
import { cmuxRuntime } from "@swarl/cmux";
import { fileURLToPath } from "node:url";

const RUN_AGENT = fileURLToPath(new URL("../run-agent.sh", import.meta.url));

const roleAgentConnector: Connector = {
  kind: "connector",
  name: "swarl",
  buildLaunch: (opts: LaunchOpts): LaunchSpec => ({
    command: RUN_AGENT,
    args: [opts.role ?? opts.name],
  }),
};

const space = process.env.SWARL_SPACE?.trim() || "todo";
const server = process.env.SWARL_SERVERS?.trim() || DEFAULT_SERVER;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm swarl up`);
  process.exit(1);
}

const registry = new Registry();
registry.register(cmuxRuntime);
registry.register(roleAgentConnector);

const mgr = new Manager({ space, registry, servers: server, spawnMode: "cmux" });
await mgr.start();
console.log(`example-02 manager up in space "${space}" — spawn mode: cmux (run-agent.sh)`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
