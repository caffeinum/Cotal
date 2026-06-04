import { parseArgs } from "node:util";
import {
  SwarlEndpoint,
  isReachable,
  DEFAULT_SERVER,
  type ControlReply,
} from "@swarl/core";
import { c } from "../ui.js";

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
): Promise<ControlReply> {
  if (!(await isReachable(server))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm swarl up`));
    process.exit(1);
  }
  const ep = new SwarlEndpoint({
    space,
    servers: server,
    channels: [],
    registerPresence: false,
    watchPresence: false,
    card: { name: "cli", kind: "endpoint" },
  });
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

export async function start(argv: string[]): Promise<void> {
  const v = parse(argv);
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reply = await ask(v.space ?? "demo", v.server ?? DEFAULT_SERVER, "start", {
    name: v.name,
    role: v.role,
    agent: v.agent,
  });
  failIfNotOk(reply);
  const d = reply.data as { name: string; role?: string; agent: string; mode: string };
  console.log(
    c.green(`✓ started ${c.bold(d.name)}`) +
      c.dim(` (${d.role ?? "no role"} · ${d.agent} · ${d.mode})`),
  );
}

export async function stop(argv: string[]): Promise<void> {
  const v = parse(argv);
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reply = await ask(v.space ?? "demo", v.server ?? DEFAULT_SERVER, "stop", {
    name: v.name,
  });
  failIfNotOk(reply);
  console.log(c.dim(`✓ stopped ${v.name}`));
}

export async function ps(argv: string[]): Promise<void> {
  const v = parse(argv);
  const reply = await ask(v.space ?? "demo", v.server ?? DEFAULT_SERVER, "ps");
  failIfNotOk(reply);
  const rows =
    (reply.data as Array<{ name: string; role?: string; agent: string; mode: string; mesh: string }>) ??
    [];
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
      `${c.bold(r.name)}${r.role ? c.dim("/" + r.role) : ""}  ${c.dim(r.agent + " · " + r.mode)}  ${status}`,
    );
  }
}
