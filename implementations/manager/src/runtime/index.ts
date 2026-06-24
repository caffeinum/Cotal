import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registry, type Runtime, type RuntimeKind, type RuntimeProvider } from "@cotal-ai/core";
import { PtyRuntime } from "./pty.js";

export type { Runtime, RuntimeKind, AgentHandle, AttachSession } from "@cotal-ai/core";

/** How a manager picks its backend. `auto` → tmux iff already inside a tmux session AND the tmux
 *  extension is imported + available, else pty (the default). An explicit kind (e.g. `tmux`/`cmux`)
 *  is resolved from the registry — contributed by an imported integration — and fails loud if
 *  absent. No silent fallback for an explicit choice; `auto` stays opportunistic. */
export type RuntimeMode = RuntimeKind | "auto";

/** True if a runtime provider for `kind` is both registered AND reports itself available. */
function providerReady(kind: RuntimeKind): boolean {
  try {
    return registry.resolve<RuntimeProvider>("runtime", kind).available();
  } catch {
    return false;
  }
}

/** Build the runtime a manager will spawn through. `pty` ships with the manager;
 *  `tmux` and `cmux` are extensions — resolved from a registered {@link RuntimeProvider}
 *  they self-register on import (`@cotal-ai/tmux`, `@cotal-ai/cmux`). `session` names
 *  the tmux session (per space) for tmux.
 *
 *  `auto` is opportunistic: it uses tmux only when we're inside `$TMUX` AND a tmux provider is
 *  registered + available; otherwise pty. So a manager-only composition root (no `@cotal-ai/tmux`)
 *  run inside tmux falls back to pty instead of throwing. An explicit `--runtime tmux`/`cmux` still
 *  resolves strictly and throws if the integration isn't imported. */
export function createRuntime(mode: RuntimeMode, session: string): Runtime {
  const kind: RuntimeKind =
    mode === "auto" ? (process.env.TMUX && providerReady("tmux") ? "tmux" : "pty") : mode;
  if (kind === "pty") return new PtyRuntime();
  let provider: RuntimeProvider;
  try {
    provider = registry.resolve<RuntimeProvider>("runtime", kind);
  } catch {
    throw new Error(
      `unknown runtime "${kind}" — is its integration imported? (e.g. import "@cotal-ai/tmux" or "@cotal-ai/cmux")`,
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
