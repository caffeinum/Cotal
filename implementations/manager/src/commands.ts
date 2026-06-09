import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  registry,
  type Command,
  type ControlReply,
} from "@cotal-ai/core";
import { attachClient } from "./attach-client.js";
import { c } from "./ui.js";

type Values = Record<string, string | undefined>;

function parse(argv: string[]): Values {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      agent: { type: "string" },
      config: { type: "string" },
      creds: { type: "string" },
    },
  });
  return values as Values;
}

/** Connect a short-lived client, send one control request to the manager, disconnect. */
async function ask(
  space: string,
  server: string,
  op: string,
  args?: Record<string, unknown>,
  credsPath?: string,
): Promise<ControlReply> {
  const creds = credsPath ? readFileSync(credsPath, "utf8") : undefined;
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false, // request/reply only — binds no consumers (and under auth has no pre-created DM durable)
    registerPresence: false,
    watchPresence: false,
    card: { name: "cli", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    return await ep.requestControl("manager", { op, args });
  } catch (e) {
    return { ok: false, error: `no manager reachable (${(e as Error).message})` };
  } finally {
    await ep.stop();
  }
}

function failIfNotOk(reply: ControlReply): void {
  if (!reply.ok) {
    console.error(c.red(`✗ ${reply.error ?? "error"}`));
    process.exit(1);
  }
}

async function start(argv: string[]): Promise<void> {
  const v = parse(argv);
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reply = await ask(v.space ?? "demo", v.server ?? DEFAULT_SERVER, "start", {
    name: v.name,
    role: v.role,
    agent: v.agent,
    config: v.config,
  }, v.creds);
  failIfNotOk(reply);
  const d = reply.data as { name: string; role?: string; agent: string; mode: string };
  console.log(
    c.green(`✓ started ${c.bold(d.name)}`) +
      c.dim(` (${d.role ?? "no role"} · ${d.agent} · ${d.mode})`),
  );
}

async function stop(argv: string[]): Promise<void> {
  const v = parse(argv);
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reply = await ask(v.space ?? "demo", v.server ?? DEFAULT_SERVER, "stop", {
    name: v.name,
  }, v.creds);
  failIfNotOk(reply);
  console.log(c.dim(`✓ stopped ${v.name}`));
}

async function ps(argv: string[]): Promise<void> {
  const v = parse(argv);
  const reply = await ask(v.space ?? "demo", v.server ?? DEFAULT_SERVER, "ps", undefined, v.creds);
  failIfNotOk(reply);
  const rows =
    (reply.data as Array<{
      name: string;
      role?: string;
      agent: string;
      mode: string;
      mesh: string;
    }>) ?? [];
  if (!rows.length) {
    console.log(c.dim("(no managed agents)"));
    return;
  }
  for (const r of rows) {
    const status =
      r.mesh === "absent"
        ? c.yellow("starting…")
        : r.mesh === "offline"
          ? c.dim("offline")
          : r.mesh === "working"
            ? c.green("working")
            : r.mesh === "waiting"
              ? c.yellow("waiting")
              : c.cyan(r.mesh);
    console.log(
      `${c.bold(r.name)}${r.role ? c.dim("/" + r.role) : ""}  ${c.dim(
        r.agent + " · " + r.mode,
      )}  ${status}`,
    );
  }
}

async function attach(argv: string[]): Promise<void> {
  const v = parse(argv);
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reply = await ask(v.space ?? "demo", v.server ?? DEFAULT_SERVER, "attach", {
    name: v.name,
  }, v.creds);
  failIfNotOk(reply);
  const { ws } = reply.data as { ws: string };
  console.error(c.dim(`attached to ${v.name} — Ctrl-] to detach`));
  await attachClient(ws);
  console.error(c.dim(`\ndetached from ${v.name}`));
}

/** The manager's control-plane commands — thin NATS request/reply clients that
 *  drive a running manager. Self-registered on import; the `cotal` binary resolves
 *  them from the registry. */
const managerCommands: Command[] = [
  {
    kind: "command",
    name: "start",
    group: "Control plane",
    summary:
      "ask the manager to spawn an agent — --name <n> [--role <r>] [--agent <a>] [--config <file>] (auto-discovers .cotal/agents/<n>.md)",
    run: start,
  },
  {
    kind: "command",
    name: "stop",
    group: "Control plane",
    summary: "ask the manager to stop an agent — --name <n>",
    run: stop,
  },
  {
    kind: "command",
    name: "ps",
    group: "Control plane",
    summary: "list managed agents + their mesh status",
    run: ps,
  },
  {
    kind: "command",
    name: "attach",
    group: "Control plane",
    summary: "stream + drive an agent's terminal (pty runtime) — --name <n>",
    run: attach,
  },
];

registry.register(...managerCommands);
