import type { Extension } from "./registry.js";
import type { LaunchSpec } from "./connector.js";

/** Where a runtime should place the spawned process. */
export interface SpawnContext {
  cwd: string;
}

/** Opaque handle a {@link Runtime} returns so it can later stop what it spawned. */
export interface SpawnHandle {
  /** The runtime that created this (its extension name) — routes the later stop. */
  runtime: string;
  /** Runtime-specific bookkeeping (pid, surface id, temp script, …). */
  ref?: Record<string, unknown>;
}

/**
 * A spawn backend: knows how to place a {@link LaunchSpec} into the world — a tmux
 * window, a detached process, a cmux pane — and stop it again. Resolved by name
 * from the registry, exactly like a {@link Connector}; `name` is the spawn-mode key.
 */
export interface Runtime extends Extension {
  readonly kind: "runtime";
  spawn(name: string, spec: LaunchSpec, ctx: SpawnContext): SpawnHandle;
  stop(handle: SpawnHandle): void;
}
