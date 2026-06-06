import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { SwarlEndpoint, isReachable, DEFAULT_SERVER } from "@swarl/core";
import { c, statusBadge } from "../ui.js";

export async function watch(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { space: { type: "string" }, server: { type: "string" }, creds: { type: "string" } },
  });
  const space = values.space ?? "demo";
  const server = values.server ?? DEFAULT_SERVER;
  const creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm swarl up`));
    process.exit(1);
  }

  const ep = new SwarlEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    registerPresence: false,
    watchPresence: true,
    card: { name: "watch", kind: "endpoint" },
  });

  const ts = () => c.dim(new Date().toLocaleTimeString());
  const who = (name: string, role?: string) =>
    `${c.bold(name)}${role ? c.dim("/" + role) : ""}`;

  ep.on("presence", (ev) => {
    const label =
      ev.type === "join"
        ? c.green("join   ")
        : ev.type === "offline"
          ? c.dim("offline")
          : c.yellow("update ");
    const activity = ev.presence.activity ? c.dim(" — " + ev.presence.activity) : "";
    console.log(
      `${ts()} ${label} ${who(ev.presence.card.name, ev.presence.card.role)} ${statusBadge(ev.presence.status)}${activity}`,
    );
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));

  await ep.start();
  ep.tap((subject, msg) => {
    if (!msg) return;
    const kind = subject.includes(".inst.")
      ? c.magenta("unicast")
      : subject.includes(".svc.")
        ? c.yellow("anycast")
        : c.cyan("chat   ");
    const text = msg.parts
      ?.map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data)))
      .join(" ");
    const arrow = msg.to
      ? c.dim(" → " + msg.to.slice(0, 8))
      : msg.toService
        ? c.dim(" → @" + msg.toService)
        : "";
    console.log(
      `${ts()} ${kind} ${who(msg.from?.name ?? "?", msg.from?.role)}${arrow}: ${text}`,
    );
  });

  console.log(c.dim(`watching space ${c.bold(space)} — Ctrl-C to stop\n`));
  process.on("SIGINT", () => void ep.stop().then(() => process.exit(0)));
  await new Promise<void>(() => {});
}
