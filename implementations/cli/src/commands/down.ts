import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../ui.js";

/** Stop the background mesh and web dashboard started by `cotal up --detach` / `cotal setup`. */
export async function down(): Promise<void> {
  const meshPid = resolve(".cotal/nats.pid");
  if (!existsSync(meshPid)) {
    console.error(c.red("No background mesh found (.cotal/nats.pid missing). Was it started with `cotal up --detach`?"));
    process.exit(1);
  }
  stop(meshPid, "nats-server");
  const webPid = resolve(".cotal/web.pid");
  if (existsSync(webPid)) stop(webPid, "web dashboard");
}

function stop(pidPath: string, label: string): void {
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(c.green(`✓ stopped ${label} (pid ${pid})`));
  } catch {
    console.log(c.dim(`${label} (pid ${pid}) was not running.`));
  }
  rmSync(pidPath);
}
