import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SpawnMode = "tmux" | "detached";

export interface SpawnSpec {
  command: string;
  args: string[];
}

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

/** Build the command that launches a given agent type as a Swarl mesh node. */
export function buildSpawn(
  agent: string,
  opts: { space: string; name: string; role?: string; servers?: string },
): SpawnSpec {
  if (agent === "swarl") {
    const args = ["swarl", "join", "--space", opts.space, "--name", opts.name];
    if (opts.role) args.push("--role", opts.role);
    if (opts.servers) args.push("--server", opts.servers);
    return { command: "pnpm", args };
  }
  throw new Error(`agent type "${agent}" not wired yet (needs the connector plugin)`);
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
  spec: SpawnSpec,
  cwd: string,
): Spawned {
  if (!hasSession(session)) {
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", cwd], {
      stdio: "ignore",
    });
  }
  const cmd = [spec.command, ...spec.args].map(shellQuote).join(" ");
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

export function spawnDetached(spec: SpawnSpec, cwd: string, logPath: string): Spawned {
  mkdirSync(dirname(logPath), { recursive: true });
  const out = openSync(logPath, "a");
  const child = spawn(spec.command, spec.args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
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
