import { execFileSync } from "node:child_process";

// Inside a cmux surface the CLI isn't on $PATH; cmux exports its absolute path here.
// Fall back to "cmux" for non-bundled installs (e.g. a Homebrew cmux on PATH).
const CMUX_BIN = process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux";

/**
 * The one place that knows the cmux CLI. Thin wrappers over `cmux <subcommand>`
 * (the CLI talks to the running cmux app over its Unix socket). Used by the
 * manager's cmux runtime and by example launchers — so no raw `cmux` calls live
 * anywhere else.
 */
function cmux(args: string[]): void {
  execFileSync(CMUX_BIN, args, { stdio: "ignore" });
}

/** True if a cmux app is reachable (`cmux ping`). */
export function available(): boolean {
  try {
    execFileSync(CMUX_BIN, ["ping"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Open a new workspace (tab) with a declarative split layout (JSON). */
export function openWorkspace(name: string, layout: string, opts: { focus?: boolean } = {}): void {
  const focus = opts.focus ?? true;
  cmux(["new-workspace", "--name", name, "--focus", String(focus), "--layout", layout]);
}

/** Split the focused pane; the new pane becomes focused. */
export function newSplit(direction: "left" | "right" | "up" | "down"): void {
  cmux(["new-split", direction]);
}

/** Type text into the focused pane. */
export function send(text: string): void {
  cmux(["send", text]);
}

/** Send a key press (e.g. "enter") to the focused pane. */
export function sendKey(key: string): void {
  cmux(["send-key", key]);
}
