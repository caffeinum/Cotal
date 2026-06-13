import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registry, type Runtime, type RuntimeKind, type RuntimeProvider } from "@cotal-ai/core";
import { PtyRuntime } from "./pty.js";
import { TmuxRuntime, tmuxAvailable } from "./tmux.js";

export type { Runtime, RuntimeKind, AgentHandle, AttachSession } from "@cotal-ai/core";

/** How a manager picks its backend. `auto` → tmux iff already inside a tmux
 *  session, else pty (the default). Any other kind (e.g. `cmux`) is resolved from
 *  the registry — contributed by an imported integration. No silent fallback. */
export type RuntimeMode = RuntimeKind | "auto";

/** Build the runtime a manager will spawn through. `pty`/`tmux` ship with the
 *  manager; other kinds are resolved from a registered {@link RuntimeProvider}
 *  (e.g. `@cotal-ai/cmux`). `session` names the tmux session (per space) for tmux. */
export function createRuntime(mode: RuntimeMode, session: string): Runtime {
  const kind: RuntimeKind = mode === "auto" ? (process.env.TMUX ? "tmux" : "pty") : mode;
  if (kind === "pty") return new PtyRuntime();
  if (kind === "tmux") {
    if (!tmuxAvailable()) throw new Error("tmux runtime requested but tmux is not installed");
    return new TmuxRuntime(session);
  }
  let provider: RuntimeProvider;
  try {
    provider = registry.resolve<RuntimeProvider>("runtime", kind);
  } catch {
    throw new Error(
      `unknown runtime "${kind}" — is its integration imported? (e.g. import "@cotal-ai/cmux")`,
    );
  }
  if (!provider.available())
    throw new Error(`${kind} runtime requested but it is not reachable`);
  return provider.create({ session });
}

/** Walk up from `startDir` to the pnpm workspace root (for spawning `pnpm cotal …`). */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}
