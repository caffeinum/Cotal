import { registry, type Command } from "@swarl/core";
import { up } from "./commands/up.js";
import { join } from "./commands/join.js";
import { watch } from "./commands/watch.js";
import { console_ } from "./commands/console.js";
import { spawn } from "./commands/spawn.js";

/** The minimal mesh CLI: thin NATS clients (up/join/watch), plus `spawn` — a
 *  foreground agent launch that reuses the connector's launch recipe. Self-registers
 *  on import; heavier surfaces (the manager's control plane) register the same way
 *  and are composed at a root. */
const baseCommands: Command[] = [
  {
    kind: "command",
    name: "up",
    group: "Mesh",
    summary: "start a local nats-server (JetStream)",
    run: up,
  },
  {
    kind: "command",
    name: "join",
    group: "Mesh",
    summary: "join a space (interactive) — --space <s> --name <n> [--role <r>]",
    run: join,
  },
  {
    kind: "command",
    name: "watch",
    group: "Mesh",
    summary: "observe all activity in a space — --space <s>",
    run: watch,
  },
  {
    kind: "command",
    name: "console",
    group: "Mesh",
    summary: "live agent dashboard for a space — --space <s> [--plain]",
    run: console_,
  },
  {
    kind: "command",
    name: "spawn",
    group: "Agents",
    summary:
      "launch an agent in this terminal from a file — spawn <name-or-path> | --name <n> --config <path> [--agent <a>] [--role <r>]",
    run: spawn,
  },
];

registry.register(...baseCommands);

export { runCli } from "./command.js";
export { c, statusBadge } from "./ui.js";
