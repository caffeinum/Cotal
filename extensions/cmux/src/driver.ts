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
function cmux(args: string[]): string {
  return execFileSync(CMUX_BIN, args, { encoding: "utf8" }).trim();
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A terminal target — a workspace (tab) or a specific surface, by id/ref. */
export interface Target {
  workspace?: string;
  surface?: string;
}

function targetArgs(t?: Target): string[] {
  const a: string[] = [];
  if (t?.workspace) a.push("--workspace", t.workspace);
  if (t?.surface) a.push("--surface", t.surface);
  return a;
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

/** Open a new workspace (tab) with a declarative split layout (JSON). Returns the
 *  new workspace's stable UUID so callers can later target or close it. */
export function openWorkspace(name: string, layout: string, opts: { focus?: boolean } = {}): string {
  const focus = opts.focus ?? true;
  const out = cmux([
    "--id-format",
    "uuids",
    "new-workspace",
    "--name",
    name,
    "--focus",
    String(focus),
    "--layout",
    layout,
  ]);
  // cmux prints a UUID under `--id-format uuids`, but write ops like new-workspace
  // confirm with `OK workspace:<n>` (a short ref) — accept either.
  const id = UUID.exec(out)?.[0] ?? /workspace:\d+/.exec(out)?.[0];
  if (!id) throw new Error(`cmux new-workspace: couldn't read the new workspace id from "${out}"`);
  return id;
}

/** Close a workspace (tab) by id/ref. */
export function closeWorkspace(workspace: string): void {
  cmux(["close-workspace", "--workspace", workspace]);
}

/** All open workspace lines (name + ref), or `[]` if cmux can't be reached. */
export function listWorkspaces(): string[] {
  try {
    return cmux(["list-workspaces"]).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Workspace refs (e.g. "workspace:55") whose label is exactly `name`. cmux lists tabs as
 *  "[*] <ref>  [glyph] <label> [\[selected\]]"; matching the whole label keeps "cotal-main" from
 *  matching "cotal-manager". Used to close stale tabs that linger after their process exits. */
export function workspaceRefs(name: string): string[] {
  const refs: string[] = [];
  for (const line of listWorkspaces()) {
    const ref = (line.match(/workspace:\d+/) ?? line.match(UUID))?.[0];
    if (!ref) continue;
    const label = line
      .slice(line.indexOf(ref) + ref.length)
      .replace(/\s*\[selected\]\s*$/, "")
      .trim();
    if (label === name || label.endsWith(` ${name}`)) refs.push(ref);
  }
  return refs;
}

/** Split the focused pane; the new pane becomes focused. */
export function newSplit(direction: "left" | "right" | "up" | "down"): void {
  cmux(["new-split", direction]);
}

/** Type text into a terminal surface (the focused one, or a targeted background tab). */
export function send(text: string, target?: Target): void {
  cmux(["send", ...targetArgs(target), "--", text]);
}

/** Send a key press (e.g. "enter") to a terminal surface. */
export function sendKey(key: string, target?: Target): void {
  cmux(["send-key", ...targetArgs(target), "--", key]);
}
