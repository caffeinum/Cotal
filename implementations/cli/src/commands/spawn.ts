import { spawn as spawnProcess } from "node:child_process";
import { parseArgs } from "node:util";
import {
  DEFAULT_SERVER,
  agentFilePath,
  loadAgentFile,
  registry,
  type AgentDef,
  type Connector,
} from "@swarl/core";

/**
 * `swarl spawn <name-or-path>` — launch an agent in the FOREGROUND of this
 * terminal from a local agent file, joined to the mesh with its persona.
 *
 * Unlike `swarl start` (the manager spawns into a detached PTY you attach to),
 * `swarl spawn` hands the terminal straight to the agent: run it in your shell,
 * or inside a cmux/tmux pane, and the real Claude TUI takes over.
 *
 * The launch recipe is the connector's `buildLaunch` (the single source of truth,
 * shared with the manager); only *how the spec runs* differs — foreground exec
 * here vs. a supervised runtime in the manager. The connector is resolved from
 * the registry by agent type, composed at the root.
 */
export async function spawn(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      config: { type: "string" },
      space: { type: "string" },
      server: { type: "string" },
      agent: { type: "string" },
      role: { type: "string" },
    },
  });

  // Where the config lives: --config, else the positional <name-or-path>, else
  // discover by --name (.swarl/agents/<name>.md). Same flags as `swarl start`.
  const ref = values.config ?? positionals[0] ?? values.name;
  if (!ref) {
    console.error(
      "usage: swarl spawn <name-or-path> | --config <path> | --name <n>  [--agent <a>] [--role <r>] [--space <s>] [--server <url>]",
    );
    process.exit(1);
  }

  const path = agentFilePath(process.cwd(), ref);
  let def: AgentDef;
  try {
    def = loadAgentFile(path);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }

  // --name / --role override the file (name defaults from the file's frontmatter).
  const name = values.name ?? def.name;
  const role = values.role ?? def.role;
  const connector = registry.resolve<Connector>("connector", values.agent ?? "claude");
  const spec = connector.buildLaunch({
    space: values.space ?? "demo",
    name,
    role,
    servers: values.server ?? DEFAULT_SERVER,
    configPath: path,
  });

  console.error(
    `spawning ${name}${role ? ` (${role})` : ""} on the mesh — press Enter at the dev-channels prompt`,
  );
  const child = spawnProcess(spec.command, spec.args, {
    stdio: "inherit",
    env: { ...process.env, ...spec.env },
  });
  await new Promise<void>((resolve) => {
    child.on("error", (e) => {
      console.error(`✗ failed to launch ${spec.command}: ${e.message}`);
      process.exitCode = 1;
      resolve();
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
