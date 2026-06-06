/**
 * Composition root for example 02. Runs a manager that spawns teammates into their
 * own cmux tabs (the `cmux` runtime) — but unlike the built-in `swarl` peer (a bare
 * `swarl join` node), each spawn is a *real coder*: this connector launches
 * `run-agent.sh <role>`, which cd's into the role's repo and starts claude with its
 * CLAUDE.md + the swarl MCP server/hooks. Registered as "swarl" — the manager's
 * default agent type — so the orchestrator's `swarl_spawn(name, role)` routes here.
 *
 * The manager must run INSIDE a live cmux surface (cmux only authorizes its control
 * socket from a real pane); launch.sh opens it in its own `swarl-manager` tab.
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
registry.register(roleAgentConnector);

const space = process.env.SWARL_SPACE?.trim() || "todo";
const server = process.env.SWARL_SERVERS?.trim() || DEFAULT_SERVER;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm swarl up`);
  process.exit(1);
}

const mgr = new Manager({ space, servers: server, runtime: "cmux" });
await mgr.start();
console.log(`example-02 manager up in space "${space}" — runtime: cmux (run-agent.sh per teammate)`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
