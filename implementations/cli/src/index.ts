import { registry, type Command } from "@swarl/core";
import { up } from "./commands/up.js";
import { join } from "./commands/join.js";
import { watch } from "./commands/watch.js";

/** The minimal mesh CLI: thin wrappers over the NATS client, no process logic.
 *  Self-registers on import; heavier surfaces (the manager's control plane)
 *  register themselves the same way and are composed at a root. */
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
];

registry.register(...baseCommands);

export { runCli } from "./command.js";
export { c, statusBadge } from "./ui.js";
