import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LaunchSpec, Runtime, SpawnContext, SpawnHandle } from "@swarl/core";
import * as cmux from "./driver.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Spawn an agent into its own new cmux tab (workspace), so spawned teammates get
 * room instead of crowding the spawner's column. cmux can't run a command in a fresh
 * surface directly, so we write the launch as a temp bash script and point the tab's
 * single terminal at it — sidestepping nushell↔bash quoting. Opened unfocused so the
 * human stays on the orchestrator tab; switch to the new tab to watch the worker.
 */
export const cmuxRuntime: Runtime = {
  kind: "runtime",
  name: "cmux",

  spawn(name: string, spec: LaunchSpec, ctx: SpawnContext): SpawnHandle {
    if (!cmux.available())
      throw new Error(
        `the cmux CLI (${process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux"}) couldn't reach the app — ` +
          "is cmux running, and is this process inside a cmux surface (CMUX_SOCKET_PATH set)?",
      );
    const envPrefix = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
    const cmd = [...envPrefix, spec.command, ...spec.args.map(shellQuote)].join(" ");
    const script = `#!/usr/bin/env bash\ncd ${shellQuote(ctx.cwd)}\nexec ${cmd}\n`;
    const scriptPath = join(tmpdir(), `swarl-spawn-${name}.sh`);
    writeFileSync(scriptPath, script, { mode: 0o755 });
    const layout = JSON.stringify({
      pane: { surfaces: [{ type: "terminal", command: `bash ${scriptPath}` }] },
    });
    cmux.openWorkspace(`swarl-${name}`, layout, { focus: false });
    return { runtime: "cmux", ref: { script: scriptPath } };
  },

  stop(_handle: SpawnHandle): void {
    // Best-effort: we don't track the tab's surface id — it's closed by hand.
  },
};
