import * as pty from "@lydell/node-pty";
import type { LaunchSpec } from "@swarl/core";
import type { AgentHandle, AttachSession, Runtime } from "./types.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/** How much terminal output to retain for late-attach scrollback replay. */
const SCROLLBACK_BYTES = 256 * 1024;

/**
 * The default runtime: the manager spawns the agent in a pseudo-terminal it owns
 * via `@lydell/node-pty`. A real native TUI — the manager keeps full OS-signal
 * control, and `swarl attach` streams the same PTY. Terminal I/O stays off the
 * mesh; the agent's own plugin still talks to NATS directly.
 */
export class PtyRuntime implements Runtime {
  readonly kind = "pty" as const;

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    const proc = pty.spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: { ...process.env, ...spec.env },
    });

    const dataSubs = new Set<(c: Buffer) => void>();
    const exitSubs = new Set<() => void>();
    const ring: Buffer[] = [];
    let ringBytes = 0;
    let alive = true;
    let cols = DEFAULT_COLS;
    let rows = DEFAULT_ROWS;

    proc.onData((d) => {
      const b = Buffer.from(d, "utf8");
      ring.push(b);
      ringBytes += b.length;
      while (ringBytes > SCROLLBACK_BYTES && ring.length > 1) {
        ringBytes -= ring.shift()!.length;
      }
      for (const fn of dataSubs) fn(b);
    });
    proc.onExit(() => {
      alive = false;
      for (const fn of exitSubs) fn();
    });

    return {
      name,
      kind: "pty",
      status: () => (alive ? "running" : "exited"),
      stop: () => {
        if (alive) proc.kill();
      },
      interrupt: () => {
        if (alive) proc.write("\x03");
      },
      attach: (): AttachSession => ({
        get cols() {
          return cols;
        },
        get rows() {
          return rows;
        },
        backlog: () => Buffer.concat(ring),
        onData: (fn) => {
          dataSubs.add(fn);
          return () => dataSubs.delete(fn);
        },
        onExit: (fn) => {
          exitSubs.add(fn);
          return () => exitSubs.delete(fn);
        },
        write: (data) => {
          if (alive) proc.write(data);
        },
        resize: (c, r) => {
          cols = c;
          rows = r;
          if (alive) proc.resize(c, r);
        },
      }),
    };
  }
}
