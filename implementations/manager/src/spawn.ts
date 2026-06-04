import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LaunchSpec } from "@swarl/core";

export type SpawnMode = "tmux" | "detached";

export interface Spawned {
  mode: SpawnMode;
  pid?: number;
  window?: string;
  session?: string;
}

/** Walk up from `startDir` to the pnpm workspace root (for spawning `pnpm swarl …`). */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function hasSession(session: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function spawnTmux(
  session: string,
  windowName: string,
  spec: LaunchSpec,
  cwd: string,
): Spawned {
  if (!hasSession(session)) {
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", cwd], {
      stdio: "ignore",
    });
  }
  const envPrefix = Object.entries(spec.env ?? {}).map(
    ([k, v]) => `${k}=${shellQuote(v)}`,
  );
  const cmd = [...envPrefix, spec.command, ...spec.args.map(shellQuote)].join(" ");
  execFileSync(
    "tmux",
    ["new-window", "-t", session, "-n", windowName, "-c", cwd, cmd],
    { stdio: "ignore" },
  );
  return { mode: "tmux", window: windowName, session };
}

export function killTmux(session: string, windowName: string): void {
  try {
    execFileSync("tmux", ["kill-window", "-t", `${session}:${windowName}`], {
      stdio: "ignore",
    });
  } catch {
    /* already gone */
  }
}

export function spawnDetached(spec: LaunchSpec, cwd: string, logPath: string): Spawned {
  mkdirSync(dirname(logPath), { recursive: true });
  const out = openSync(logPath, "a");
  const child = spawn(spec.command, spec.args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
  });
  child.unref();
  return { mode: "detached", pid: child.pid };
}

export function killDetached(pid: number): void {
  // The child is detached (its own process group leader), so signal the whole
  // group — otherwise the `pnpm` wrapper dies but its `tsx/node` child orphans.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
