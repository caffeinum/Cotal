import { registry, type Command } from "@cotal/core";
import { up } from "./commands/up.js";
import { join } from "./commands/join.js";
import { watch } from "./commands/watch.js";
import { console_ } from "./commands/console.js";
import { consoleInk } from "./commands/console-ink.js";
import { web } from "./commands/web.js";
import { spawn } from "./commands/spawn.js";
import { mint } from "./commands/mint.js";

/** The minimal mesh CLI: thin NATS clients (up/join/watch), plus `spawn` — a
 *  foreground agent launch that reuses the connector's launch recipe. Self-registers
 *  on import; heavier surfaces (the manager's control plane) register the same way
 *  and are composed at a root. */
const baseCommands: Command[] = [
  {
    kind: "command",
    name: "up",
    group: "Mesh",
    summary: "start a local nats-server (JetStream, JWT auth by default; --open for an unauthenticated dev mesh)",
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
    name: "console-ink",
    group: "Mesh",
    summary: "live agent dashboard (Ink/React TUI, lazygit-style) — --space <s> [--plain]",
    run: consoleInk,
  },
  {
    kind: "command",
    name: "web",
    group: "Mesh",
    summary: "browser observability dashboard — presence, channels, live feed — --space <s> [--port <n>] [--no-open]",
    run: web,
  },
  {
    kind: "command",
    name: "spawn",
    group: "Agents",
    summary:
      "launch an agent in this terminal from a file — spawn <name-or-path> | --name <n> --config <path> [--agent <a>] [--role <r>]",
    run: spawn,
  },
  {
    kind: "command",
    name: "mint",
    group: "Mesh",
    summary: "mint a creds file for a space (auth mode) — mint <name> --profile <agent|observer> [--out <path>]",
    run: mint,
  },
];

registry.register(...baseCommands);

export { runCli } from "./command.js";
export { c, statusBadge } from "./ui.js";
