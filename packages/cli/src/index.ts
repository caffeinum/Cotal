import { c } from "./ui.js";
import { up } from "./commands/up.js";
import { join } from "./commands/join.js";
import { watch } from "./commands/watch.js";

const [, , cmd, ...rest] = process.argv;

function help(): void {
  console.log(`${c.bold("swarl")} — lateral agent coordination over NATS

${c.bold("Usage")}
  swarl up                            start a local nats-server (JetStream)
  swarl join --space <s> --name <n>   join a space (interactive)
       [--role <r>] [--channel <c>]
  swarl watch --space <s>             observe all activity in a space

${c.bold("Examples")}
  pnpm swarl up
  pnpm swarl join --space demo --name alice --role planner
  pnpm swarl watch --space demo
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
