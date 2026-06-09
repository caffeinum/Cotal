import type { LaunchSpec } from "@cotal/core";

export type RuntimeKind = "pty" | "tmux" | "cmux";

/** A live attach onto a running agent's terminal — the stream `cotal attach`
 *  (and, later, the browser console) consumes. PTY frames flow here directly,
 *  never over the mesh. */
export interface AttachSession {
  readonly cols: number;
  readonly rows: number;
  /** Scrollback so a late attach sees output that already scrolled past. */
  backlog(): Buffer;
  /** Subscribe to live output; returns an unsubscribe fn. */
  onData(fn: (chunk: Buffer) => void): () => void;
  /** Fires when the underlying process exits; returns an unsubscribe fn. */
  onExit(fn: () => void): () => void;
  /** Forward keystrokes to the process. */
  write(data: string): void;
  /** Resize the pseudo-terminal. */
  resize(cols: number, rows: number): void;
}

/** An OS handle on one spawned agent — the manager owns this to *control* the
 *  process (the mesh observes its presence separately). */
export interface AgentHandle {
  readonly name: string;
  readonly kind: RuntimeKind;
  status(): "running" | "exited";
  /** Tear the agent down. `graceful` (default) signals a clean exit (so the session
   *  leaves the mesh on its own) before ensuring the process/tab is gone; otherwise
   *  it's a hard, immediate kill. */
  stop(opts?: { graceful?: boolean }): void;
  interrupt(): void;
  /** Open a live attach. Throws on backends that can't stream (e.g. tmux, which
   *  you attach to natively). */
  attach(): AttachSession;
}

/** A pluggable agent backend — `pty` (default) owns a real pseudo-terminal;
 *  `tmux` (opt-in) drives a multiplexer pane. Selectable, no silent fallback. */
export interface Runtime {
  readonly kind: RuntimeKind;
  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle;
}
