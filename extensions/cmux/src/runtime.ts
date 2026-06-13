import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registry,
  type AgentHandle,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
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

/**
 * Spawns each agent into its own new cmux tab (workspace), so spawned teammates get
 * room instead of crowding the spawner. cmux can't run a command in a fresh surface
 * directly, so we write the launch as a temp bash script and point the tab's terminal
 * at it — sidestepping nushell↔bash quoting. Opened unfocused so the human stays put;
 * switch to the new tab to watch the worker. Like tmux, you watch it natively, so
 * `attach()` throws — but teardown is real: we keep the tab's workspace + surface ids
 * to drive and close it.
 */
export class CmuxRuntime implements Runtime {
  readonly kind = "cmux";

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    // `name` becomes a temp-script filename and a `cotal-<name>` tab id — keep it a bare token
    // so it can't traverse paths or break the workspace label.
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(`cmux runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`);
    if (!cmux.available())
      throw new Error(
        `the cmux CLI (${process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux"}) couldn't reach the app — ` +
          "is cmux running, and is this process inside a cmux surface (CMUX_SOCKET_PATH set)?",
      );
    const envPrefix = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
    const cmd = [...envPrefix, shellQuote(spec.command), ...spec.args.map(shellQuote)].join(" ");
    // If the launch shows a one-time confirm (Claude's dev-channels prompt), auto-clear it by
    // sending Enter to this tab's own surface a few times — so a spawned teammate joins the mesh
    // without anyone switching to its tab to press Enter. (Same trick as run-agent.sh.)
    const autoConfirm = spec.confirm ? `${ENTER_LOOP}\n` : "";
    // `exec env …` (not `exec …`): exec can't take KEY=val assignments — `env` applies them
    // then execs the agent. Without it the script dies with "exec: COTAL_SPACE=…: not found".
    const script = `#!/usr/bin/env bash\ncd ${shellQuote(cwd)}\n${autoConfirm}exec env ${cmd}\n`;
    const scriptPath = join(tmpdir(), `cotal-spawn-${name}.sh`);
    writeFileSync(scriptPath, script, { mode: 0o755 });
    const layout = JSON.stringify({
      pane: { surfaces: [{ type: "terminal", command: `bash ${scriptPath}` }] },
    });
    // Keep the new tab's workspace ref so we can drive (send keys to its terminal)
    // and close it later. cmux targets the tab's single terminal surface by workspace.
    const workspace = cmux.openWorkspace(`cotal-${name}`, layout, { focus: false });

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
