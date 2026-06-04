import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PtyRuntime } from "./pty.js";
import { TmuxRuntime, tmuxAvailable } from "./tmux.js";
import type { Runtime, RuntimeKind } from "./types.js";

export type { Runtime, RuntimeKind, AgentHandle, AttachSession } from "./types.js";

/** How a manager picks its backend. `auto` → tmux iff already inside a tmux
 *  session, else pty (the default). No silent fallback: an explicit `tmux` with
 *  tmux missing throws. */
export type RuntimeMode = RuntimeKind | "auto";

/** Build the runtime a manager will spawn through. `session` names the tmux
 *  session (per space) when the tmux backend is selected. */
export function createRuntime(mode: RuntimeMode, session: string): Runtime {
  const kind: RuntimeKind = mode === "auto" ? (process.env.TMUX ? "tmux" : "pty") : mode;
  if (kind === "tmux") {
    if (!tmuxAvailable()) throw new Error("tmux runtime requested but tmux is not installed");
    return new TmuxRuntime(session);
  }
  return new PtyRuntime();
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
