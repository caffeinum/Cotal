import * as pty from "@lydell/node-pty";
import type { LaunchSpec } from "@cotal/core";
import type { AgentHandle, AttachSession, Runtime } from "./types.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/** How much terminal output to retain for late-attach scrollback replay. */
const SCROLLBACK_BYTES = 256 * 1024;
/** Stop watching for a spawn-confirm prompt after this long (it appears at startup). */
const CONFIRM_WINDOW_MS = 20_000;

/** Strip ANSI control sequences and whitespace so a confirm prompt matches regardless
 *  of how a TUI positions its text (cursor moves between words, not spaces). */
function normalizeForMatch(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-Z\\-_]/g, "") // other escapes
    .replace(/\s+/g, "");
}

/**
 * The default runtime: the manager spawns the agent in a pseudo-terminal it owns
 * via `@lydell/node-pty`. A real native TUI — the manager keeps full OS-signal
 * control, and `cotal attach` streams the same PTY. Terminal I/O stays off the
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

    // Auto-clear a one-time spawn prompt (e.g. Claude's dev-channel confirmation):
    // watch early output for `spec.confirm` and press Enter once when it appears.
    const confirmTarget = spec.confirm ? normalizeForMatch(spec.confirm) : "";
    let confirmArmed = Boolean(confirmTarget);
    let confirmBuf = "";
    if (confirmArmed) setTimeout(() => (confirmArmed = false), CONFIRM_WINDOW_MS);

    proc.onData((d) => {
      const b = Buffer.from(d, "utf8");
      ring.push(b);
      ringBytes += b.length;
      while (ringBytes > SCROLLBACK_BYTES && ring.length > 1) {
        ringBytes -= ring.shift()!.length;
      }
      if (confirmArmed) {
        confirmBuf = (confirmBuf + d).slice(-8192);
        if (normalizeForMatch(confirmBuf).includes(confirmTarget)) {
          confirmArmed = false;
          // Let the TUI finish wiring up its raw-mode input loop (it may flush
          // stdin on init) before pressing Enter, or the keypress is dropped.
          setTimeout(() => alive && proc.write("\r"), 500);
        }
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
