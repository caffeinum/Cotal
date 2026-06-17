import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registry,
  type AgentHandle,
  type LaunchSpec,
  type Pane,
  type Runtime,
  type RuntimeProvider,
  type Tab,
  type TerminalLayout,
} from "@cotal-ai/core";
import * as cmux from "./driver.js";

/** Grace window for a clean exit before a graceful stop force-closes the tab. */
const GRACE_MS = 1_500;

/** Background snippet that auto-accepts a one-time confirm prompt by pressing Enter on the
 *  pane's own cmux surface a few times. Gated on the cmux env vars so it's a no-op off cmux. */
const ENTER_LOOP =
  '[ -n "$CMUX_SURFACE_ID" ] && [ -n "$CMUX_BUNDLED_CLI_PATH" ] && ' +
  '( for _ in 1 2 3 4 5; do sleep 1; "$CMUX_BUNDLED_CLI_PATH" send-key --surface "$CMUX_SURFACE_ID" enter >/dev/null 2>&1; done ) &';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** cmux can't run a command in a fresh surface directly, and panes start under a login shell
 *  (maybe nushell) before bash — so we write each pane's launch as a temp bash script and point
 *  the tab at it, sidestepping all shell quoting (callers pass argv, never shell strings). `login`
 *  runs it as a login shell (`bash -l`) so the user's PATH is present — setup's panes run further
 *  `cotal` subcommands that resolve `claude`. `exec env …` (not `exec …`): exec can't take KEY=val
 *  assignments, so `env` applies them and then execs the command. */
function paneCommand(pane: Pane, key: string, login: boolean): string {
  const env = Object.entries(pane.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const cmd = [...env, shellQuote(pane.command), ...(pane.args ?? []).map(shellQuote)].join(" ");
  const cd = pane.cwd ? `cd ${shellQuote(pane.cwd)}\n` : "";
  const confirm = pane.confirm ? `${ENTER_LOOP}\n` : "";
  const script = `#!/usr/bin/env bash\n${cd}${confirm}exec env ${cmd}\n`;
  const scriptPath = join(tmpdir(), `cotal-pane-${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.sh`);
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return `bash ${login ? "-l " : ""}${scriptPath}`;
}

/** A single-terminal pane node in cmux's layout JSON. */
function surface(command: string): unknown {
  return { pane: { surfaces: [{ type: "terminal", command }] } };
}

/** Translate a backend-agnostic {@link Tab} into a cmux layout JSON string — the one place that
 *  knows cmux's layout shape. One pane → a bare terminal; several → a split (`direction` + `split`
 *  ratio). These panes run under a login shell. */
function cmuxLayout(label: string, tab: Tab): string {
  const nodes = tab.panes.map((p, i) => surface(paneCommand(p, `${label}-${i}`, true)));
  if (nodes.length === 1 && !tab.split) return JSON.stringify(nodes[0]);
  if (!tab.split)
    throw new Error(`cmux layout "${label}": ${nodes.length} panes need a split (direction + ratio)`);
  return JSON.stringify({ direction: tab.split.direction, split: tab.split.ratio, children: nodes });
}

/**
 * Spawns each agent into its own new cmux tab (workspace), so spawned teammates get
 * room instead of crowding the spawner. The launch goes through {@link paneCommand}
 * (a temp bash script) — non-login, since the agent's command is an absolute path.
 * Opened unfocused so the human stays put; switch to the new tab to watch the worker.
 * Like tmux, you watch it natively, so `attach()` throws — but teardown is real: we
 * keep the tab's workspace + surface ids to drive and close it.
 */
export class CmuxRuntime implements Runtime {
  readonly kind = "cmux";

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    // `name` becomes a temp-script key and a `cotal-<name>` tab id — keep it a bare token
    // so it can't traverse paths or break the workspace label.
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(`cmux runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`);
    if (!cmux.available())
      throw new Error(
        `the cmux CLI (${process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux"}) couldn't reach the app — ` +
          "is cmux running, and is this process inside a cmux surface (CMUX_SOCKET_PATH set)?",
      );
    // `confirm` auto-clears a one-time prompt (Claude's dev-channels) by sending Enter to this
    // tab's own surface — so a spawned teammate joins the mesh without anyone switching to its tab.
    const command = paneCommand(
      { command: spec.command, args: spec.args, env: spec.env, cwd, confirm: Boolean(spec.confirm) },
      `spawn-${name}`,
      false,
    );
    // Keep the new tab's workspace ref so we can drive (send keys to its terminal)
    // and close it later. cmux targets the tab's single terminal surface by workspace.
    const workspace = cmux.openWorkspace(`cotal-${name}`, JSON.stringify(surface(command)), { focus: false });

    return {
      name,
      kind: "cmux",
      status: () => "running",
      stop: (opts) => {
        if (opts?.graceful === false) {
          cmux.closeWorkspace(workspace);
          return;
        }
        // Graceful: type `/exit` so the Claude session shuts down cleanly (its
        // SessionEnd hook leaves the mesh), then close the now-idle tab regardless.
        try {
          cmux.send("/exit", { workspace });
          cmux.sendKey("enter", { workspace });
        } catch {
          /* keystroke delivery failed — still ensure the tab is gone below */
        }
        setTimeout(() => cmux.closeWorkspace(workspace), GRACE_MS);
      },
      interrupt: () => {
        cmux.sendKey("ctrl+c", { workspace });
      },
      attach: () => {
        throw new Error(`cmux runtime: switch to the "cotal-${name}" cmux tab to watch it`);
      },
    };
  }
}

/** Self-registering runtime provider — `import "@cotal-ai/cmux"` makes the manager's
 *  `cmux` runtime available, without the manager depending on this package. */
export const cmuxRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "cmux",
  available: () => cmux.available(),
  create: () => new CmuxRuntime(),
};

registry.register(cmuxRuntimeProvider);

/** Self-registering terminal-layout provider — lets a caller (e.g. `cotal setup`) open/close
 *  cmux tabs by resolving `registry.resolve("terminal","cmux")`, so an implementation drives cmux
 *  without importing this package. The caller passes a backend-agnostic {@link Tab};
 *  {@link cmuxLayout} turns it into cmux's native layout JSON here, so no cmux-specific shape lives
 *  in the caller. */
export const cmuxTerminalProvider: TerminalLayout = {
  kind: "terminal",
  name: "cmux",
  available: () => cmux.available(),
  open: (label, tab, opts) => cmux.openWorkspace(label, cmuxLayout(label, tab), opts),
  close: (ref) => cmux.closeWorkspace(ref),
  refs: (label) => cmux.workspaceRefs(label),
};

registry.register(cmuxTerminalProvider);
