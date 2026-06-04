import { parseArgs } from "node:util";
import { isReachable, DEFAULT_SERVER } from "@swarl/core";
import { Manager, type SpawnMode } from "@swarl/manager";
import { c } from "../ui.js";

export async function manager(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      name: { type: "string" },
      spawn: { type: "string" },
    },
  });
  const space = values.space ?? "demo";
  const server = values.server ?? DEFAULT_SERVER;
  if (!(await isReachable(server))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm swarl up`));
    process.exit(1);
  }

  const mgr = new Manager({
    space,
    servers: server,
    name: values.name,
    spawnMode: (values.spawn as SpawnMode | "auto" | undefined) ?? "auto",
  });
  await mgr.start();

  console.log(
    c.green("✓ manager up") +
      c.dim(` — space ${c.bold(space)}, spawn mode: ${mgr.spawnMode}`),
  );
  console.log(c.dim(`control it with:  swarl start | stop | ps --space ${space}`));
  if (mgr.spawnMode === "tmux")
    console.log(c.dim(`watch agents:  tmux attach -t swarl-${space}`));
  console.log(c.dim("Ctrl-C to stop.\n"));

  process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
  await new Promise<void>(() => {});
}
