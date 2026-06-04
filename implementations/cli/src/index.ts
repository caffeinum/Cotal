import { c } from "./ui.js";
import { up } from "./commands/up.js";
import { join } from "./commands/join.js";
import { watch } from "./commands/watch.js";
import { console_ } from "./commands/console.js";
import { manager } from "./commands/manager.js";
import { start, stop, ps } from "./commands/control.js";

const [, , cmd, ...rest] = process.argv;

function help(): void {
  console.log(`${c.bold("swarl")} — lateral agent coordination over NATS

${c.bold("Mesh")}
  swarl up                            start a local nats-server (JetStream)
  swarl join --space <s> --name <n>   join a space (interactive)
       [--role <r>] [--channel <c>]
  swarl watch --space <s>             observe all activity in a space
  swarl console --space <s>           live dashboard: agent panel + message log
       [--plain]                      ...or the classic scrolling log (pipeable)

${c.bold("Manager")} (agent supervisor)
  swarl manager --space <s>           run the supervisor daemon [--spawn tmux|detached]
  swarl start --name <n> [--role <r>] ask the manager to spawn an agent
  swarl stop --name <n>               ask the manager to stop an agent
  swarl ps                            list managed agents + their mesh status

${c.bold("Examples")}
  pnpm swarl up
  pnpm swarl manager --space demo
  pnpm swarl start --space demo --name carol --role reviewer
  pnpm swarl ps --space demo
`);
}

switch (cmd) {
  case "up":
    await up(rest);
    break;
  case "join":
    await join(rest);
    break;
  case "watch":
    await watch(rest);
    break;
  case "console":
    await console_(rest);
    break;
  case "manager":
    await manager(rest);
    break;
  case "start":
    await start(rest);
    break;
  case "stop":
    await stop(rest);
    break;
  case "ps":
    await ps(rest);
    break;
  case "help":
  case "-h":
  case "--help":
  case undefined:
    help();
    break;
  default:
    console.error(c.red(`unknown command: ${cmd}`));
    help();
    process.exit(1);
}
