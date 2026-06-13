import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { selfArgv } from "./self-exec.js";
import { resolveSpace } from "./status.js";
import { cotalPath } from "./paths.js";

const PID_PATH = () => cotalPath("manager.pid");

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
export function startManagerDetached(o: { space?: string; server?: string; spawn?: string[] } = {}): number {
  const fd = openSync(cotalPath("manager.log"), "a");
  const [node, ...self] = selfArgv();
  const args = [
    ...self,
    "supervise",
    "--space",
    o.space ?? resolveSpace(process.cwd()),
    "--server",
    o.server ?? DEFAULT_SERVER,
    ...(o.spawn?.length ? ["--spawn", o.spawn.join(",")] : []),
  ];
  const child = spawn(node, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  writeFileSync(PID_PATH(), String(child.pid));
  return child.pid ?? 0;
}

/** Make the control plane available: reuse a manager already running for this folder, else start
 *  one detached. Best-effort — callers treat it as non-fatal. */
export function ensureManager(o: { space?: string; server?: string; spawn?: string[] } = {}): { running: boolean } {
  if (managerUp()) return { running: true };
  startManagerDetached(o);
  return { running: true };
}

/** Stop the detached (pty) manager if we started one. Used when switching to the cmux-tab manager
 *  so the two don't both answer the control plane (queue-grouped requests would split between them). */
export function stopManager(): void {
  const p = PID_PATH();
  if (!existsSync(p)) return;
  const pid = Number(readFileSync(p, "utf8").trim());
  if (Number.isFinite(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  rmSync(p);
}
