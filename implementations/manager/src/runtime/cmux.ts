import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LaunchSpec } from "@cotal/core";
import { cmux } from "@cotal/cmux";
import type { AgentHandle, Runtime } from "./types.js";

export function cmuxAvailable(): boolean {
  return cmux.available();
}

/** Grace window for a clean exit before a graceful stop force-closes the tab. */
const GRACE_MS = 1_500;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Opt-in runtime that spawns each agent into its own new cmux tab (workspace), so
 * spawned teammates get room instead of crowding the spawner. cmux can't run a
 * command in a fresh surface directly, so we write the launch as a temp bash
 * script and point the tab's terminal at it — sidestepping nushell↔bash quoting.
 * Opened unfocused so the human stays put; switch to the new tab to watch the
 * worker. Like tmux, you watch it natively, so `attach()` throws — but teardown is
 * real: we keep the tab's workspace + surface ids to drive and close it.
 */
export class CmuxRuntime implements Runtime {
  readonly kind = "cmux" as const;

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!cmux.available())
      throw new Error(
        `the cmux CLI (${process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux"}) couldn't reach the app — ` +
          "is cmux running, and is this process inside a cmux surface (CMUX_SOCKET_PATH set)?",
      );
    const envPrefix = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
    const cmd = [...envPrefix, spec.command, ...spec.args.map(shellQuote)].join(" ");
    const script = `#!/usr/bin/env bash\ncd ${shellQuote(cwd)}\nexec ${cmd}\n`;
    const scriptPath = join(tmpdir(), `cotal-spawn-${name}.sh`);
    writeFileSync(scriptPath, script, { mode: 0o755 });
    const layout = JSON.stringify({
      pane: { surfaces: [{ type: "terminal", command: `bash ${scriptPath}` }] },
    });
    // Keep the new tab's ids so we can drive (send keys) and close it later.
    const workspace = cmux.openWorkspace(`cotal-${name}`, layout, { focus: false });
    const surface = cmux.firstSurface(workspace);

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
        // SessionEnd hook leaves the mesh), then close the now-idle tab.
        cmux.send("/exit", { surface });
        cmux.sendKey("enter", { surface });
        setTimeout(() => cmux.closeWorkspace(workspace), GRACE_MS);
      },
      interrupt: () => {
        cmux.sendKey("ctrl+c", { surface });
      },
      attach: () => {
        throw new Error(`cmux runtime: switch to the "cotal-${name}" cmux tab to watch it`);
      },
    };
  }
}
