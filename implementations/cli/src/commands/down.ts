import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../ui.js";

/** Stop a background mesh started with `cotal up --detach`. */
export async function down(): Promise<void> {
  const pidPath = resolve(".cotal/nats.pid");
  if (!existsSync(pidPath)) {
    console.error(c.red("No background mesh found (.cotal/nats.pid missing). Was it started with `cotal up --detach`?"));
    process.exit(1);
  }
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(c.green(`✓ stopped nats-server (pid ${pid})`));
  } catch {
    console.log(c.dim(`nats-server (pid ${pid}) was not running.`));
  }
  rmSync(pidPath);
}
