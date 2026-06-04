import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LaunchSpec, Runtime, SpawnContext, SpawnHandle } from "@swarl/core";
import * as cmux from "./driver.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Spawn an agent into a new cmux pane (best-effort). cmux can't run a command in a
 * fresh split directly, so we write the launch as a temp bash script and have the
 * new (focused) pane run it — sidestepping nushell↔bash quoting when typing in.
 */
export const cmuxRuntime: Runtime = {
  kind: "runtime",
  name: "cmux",

  spawn(name: string, spec: LaunchSpec, ctx: SpawnContext): SpawnHandle {
    if (!cmux.available())
      throw new Error("the `cmux` CLI is not reachable — run the manager from inside cmux");
    const envPrefix = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
    const cmd = [...envPrefix, spec.command, ...spec.args.map(shellQuote)].join(" ");
    const script = `#!/usr/bin/env bash\ncd ${shellQuote(ctx.cwd)}\nexec ${cmd}\n`;
    const scriptPath = join(tmpdir(), `swarl-spawn-${name}.sh`);
    writeFileSync(scriptPath, script, { mode: 0o755 });
    cmux.newSplit("down");
    cmux.send(`bash ${scriptPath}`);
    cmux.sendKey("enter");
    return { runtime: "cmux", ref: { script: scriptPath } };
  },

  stop(_handle: SpawnHandle): void {
    // Best-effort: a cmux pane has no pid/window we tracked — it's closed by hand.
  },
};
