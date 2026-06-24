import { execFileSync } from "node:child_process";

/** True if tmux is installed and reachable on PATH. */
export function available(): boolean {
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

/** Session name from the surrounding tmux environment. Throws if not inside tmux. */
export function currentSession(): string {
  if (!process.env.TMUX)
    throw new Error("tmux: not inside a tmux session ($TMUX is not set)");
  try {
    return execFileSync("tmux", ["display-message", "-p", "#S"], { encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(`tmux: couldn't read current session name: ${err}`);
  }
}

function hasSession(session: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Ensure a detached tmux session exists; creates it if absent. */
export function ensureSession(session: string, cwd: string): void {
  if (!hasSession(session))
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", cwd], { stdio: "ignore" });
}

/** True if a window named `name` exists in `session`. */
export function windowAlive(session: string, name: string): boolean {
  try {
    const out = execFileSync("tmux", ["list-windows", "-t", session, "-F", "#W"], {
      encoding: "utf8",
    });
    return out.split("\n").map((l) => l.trim()).includes(name);
  } catch {
    return false;
  }
}

function isWindowGone(err: unknown): boolean {
  // Use both stderr (captured when stdio:"pipe") and message (contains the command + code).
  const e = err as { stderr?: unknown; message?: unknown };
  const msg = `${String(e.stderr ?? "")}${String(e.message ?? "")}`;
  return /can't find window|can't find session|no current window|session not found/i.test(msg);
}

/** Open a new tmux window `name` in `session` running `command` (a shell string).
 *  Created detached (unfocused) by default; pass `focus: true` to switch to it.
 *  Returns the target string `session:name`. */
export function openWindow(
  session: string,
  name: string,
  command: string,
  cwd: string,
  opts: { focus?: boolean } = {},
): string {
  const args = ["new-window", "-t", session, "-n", name, "-c", cwd];
  if (!(opts.focus ?? false)) args.push("-d");
  args.push(command);
  execFileSync("tmux", args, { stdio: "ignore" });
  return `${session}:${name}`;
}

/** Split `target` (session:window) creating a new pane running `command`.
 *  `"horizontal"` stacks panes top/bottom; `"vertical"` places them side by side.
 *  `ratio` is the first pane's fraction of the total — the new pane gets `(1 - ratio)`. */
export function splitWindow(
  target: string,
  command: string,
  cwd: string,
  direction: "vertical" | "horizontal",
  ratio?: number,
): void {
  const args = ["split-window", "-t", target, "-c", cwd];
  if (direction === "vertical") args.push("-h"); // side-by-side = tmux horizontal (-h)
  if (ratio !== undefined) args.push("-p", String(Math.round((1 - ratio) * 100)));
  args.push(command);
  execFileSync("tmux", args, { stdio: "ignore" });
}

/** Focus a window by target (`session:name`). */
export function selectWindow(target: string): void {
  execFileSync("tmux", ["select-window", "-t", target], { stdio: "ignore" });
}

/** Kill a tmux window by target (`session:name`). Idempotent: already-gone is a no-op. */
export function closeWindow(target: string): void {
  try {
    execFileSync("tmux", ["kill-window", "-t", target], { stdio: "pipe" });
  } catch (err) {
    if (isWindowGone(err)) return;
    throw err;
  }
}

/** Window names open in `session`, or `[]` if unreachable. */
export function listWindows(session: string): string[] {
  try {
    return execFileSync("tmux", ["list-windows", "-t", session, "-F", "#W"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Targets (`session:label`) of every window in `session` whose name is exactly `label`. */
export function windowRefs(session: string, label: string): string[] {
  return listWindows(session)
    .filter((name) => name === label)
    .map(() => `${session}:${label}`);
}

/** Shell command string that runs `command args` with `env -i` isolation — only the given
 *  `env` entries reach the process (the tmux server's inherited env is stripped). */
export function isolatedCommand(
  env: Record<string, string>,
  command: string,
  args: string[],
): string {
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return ["env", "-i", ...pairs, shellQuote(command), ...args.map(shellQuote)].join(" ");
}

/** Shell command string that runs `command args` with extra `env` merged into the inherited env. */
export function mergedCommand(
  env: Record<string, string>,
  command: string,
  args: string[],
): string {
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return ["env", ...pairs, shellQuote(command), ...args.map(shellQuote)].join(" ");
}

/** Type literal text into a tmux target (`session:window`).
 *  `-l` sends the string as literal keystrokes, bypassing tmux's key-name lookup. */
export function send(text: string, target: string): void {
  execFileSync("tmux", ["send-keys", "-t", target, "-l", text], { stdio: "ignore" });
}

/** Send a named key sequence (e.g. `"Enter"`, `"C-c"`) to a tmux target. */
export function sendKey(key: string, target: string): void {
  execFileSync("tmux", ["send-keys", "-t", target, key], { stdio: "ignore" });
}
