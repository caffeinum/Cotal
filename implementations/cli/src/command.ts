import type { Command, Registry } from "@cotal-ai/core";
import { c } from "./ui.js";

function help(commands: Command[]): void {
  const groups = new Map<string, Command[]>();
  for (const cmd of commands) {
    const g = cmd.group ?? "Commands";
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(cmd);
  }
  const pad = Math.max(...commands.map((c) => c.name.length));
  let out = `${c.bold("cotal")} — lateral agent coordination over NATS\n`;
  for (const [group, cmds] of groups) {
    out += `\n${c.bold(group)}\n`;
    for (const cmd of cmds) out += `  ${cmd.name.padEnd(pad)}  ${c.dim(cmd.summary)}\n`;
  }
  console.log(out);
}

/** Dispatch `argv` against the commands self-registered in a {@link Registry}.
 *  The single entry point a composition root calls — no hardcoded command list. */
export async function runCli(registry: Registry, argv: string[]): Promise<void> {
  const commands = registry.all<Command>("command");
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "-h" || name === "--help") {
    help(commands);
    return;
  }
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    console.error(c.red(`unknown command: ${name}`));
    help(commands);
    process.exit(1);
  }
  await cmd.run(rest);
}
