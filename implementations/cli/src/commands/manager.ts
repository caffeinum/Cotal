import { parseArgs } from "node:util";
import { isReachable, DEFAULT_SERVER, Registry } from "@swarl/core";
import { Manager } from "@swarl/manager";
import { cmuxRuntime } from "@swarl/cmux";
import { swarlConnector } from "../connector.js";
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

  // Shipped extensions the manager can resolve: the CLI peer connector + spawn runtimes.
  const registry = new Registry();
  registry.register(swarlConnector);
  registry.register(cmuxRuntime);

  const mgr = new Manager({
    space,
    registry,
    servers: server,
    name: values.name,
    spawnMode: values.spawn ?? "auto",
  });
  try {
    await mgr.start();
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }

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
