import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SERVER } from "@cotal-ai/core";

const PID_PATH = () => resolve(".cotal/manager.pid");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: liveness probe, doesn't actually signal
    return true;
  } catch {
    return false;
  }
}

/** True if the manager we started for this folder is still running (pid file + liveness). */
export function managerUp(): boolean {
  const p = PID_PATH();
  if (!existsSync(p)) return false;
  const pid = Number(readFileSync(p, "utf8").trim());
  return Number.isFinite(pid) && alive(pid);
}

/** Start the control-plane manager detached (pid in `.cotal/manager.pid`, output to
 *  `.cotal/manager.log`), stopped by `cotal down`. Re-execs this same CLI's `supervise` — the
 *  composed `cotal` binary registers it; `process.execArgv` carries the tsx loader in dev and is
 *  empty in prod. `supervise`'s auto runtime resolves to pty when detached, which answers the
 *  control plane (`cotal_spawn`/`despawn`/`purge`/`persona`) with no tmux/cmux needed. */
export function startManagerDetached(o: { space?: string; server?: string } = {}): number {
  const fd = openSync(resolve(".cotal/manager.log"), "a");
  const args = [
    ...process.execArgv,
    process.argv[1],
    "supervise",
    "--space",
    o.space ?? "demo",
    "--server",
    o.server ?? DEFAULT_SERVER,
  ];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  writeFileSync(PID_PATH(), String(child.pid));
  return child.pid ?? 0;
}

/** Make the control plane available: reuse a manager already running for this folder, else start
 *  one detached. Best-effort — callers treat it as non-fatal. */
export function ensureManager(o: { space?: string; server?: string } = {}): { running: boolean } {
  if (managerUp()) return { running: true };
  startManagerDetached(o);
  return { running: true };
}
