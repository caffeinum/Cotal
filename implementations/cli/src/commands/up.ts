import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isReachable, DEFAULT_SERVER } from "@swarl/core";
import { c } from "../ui.js";

export async function up(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "store-dir": { type: "string" },
    },
  });
  const server = values.server ?? DEFAULT_SERVER;
  if (await isReachable(server)) {
    console.log(c.green(`✓ NATS already running at ${server}`));
    return;
  }
  const storeDir = resolve(values["store-dir"] ?? ".swarl/nats");
  mkdirSync(storeDir, { recursive: true });
  console.log(c.dim(`Starting nats-server (JetStream) — store: ${storeDir}`));
  console.log(c.dim("Press Ctrl-C to stop.\n"));
  const child = spawn("nats-server", ["-js", "-sd", storeDir], {
    stdio: "inherit",
  });
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    console.error(c.dim("Install it with: brew install nats-server"));
    process.exit(1);
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
  await new Promise<void>(() => {});
}
