#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const host = process.env.COTAL_FEEDBACK_SSH ?? "cotal@63.143.44.130";
const remoteRoot = process.env.COTAL_FEEDBACK_REMOTE_ROOT ?? "/home/cotal/SWARL";
const [cmd, ...args] = process.argv.slice(2);

function usage() {
  console.log(`Usage: feedback-remote <command> [args]

Commands:
  health
      Check https://broker.cotal.ai/health.

  list-keys
  add-key <tester> [--name <display-name>]
  rotate-key <tester> [--name <display-name>]
  revoke-key <tester-or-key>
  pull [--limit <n>] [--json] [--tester <id>] [--origin human|agent] [--type <type>]
  restart
      Run the matching server-side feedback-admin command over SSH.

  ssh
      Open a shell in the remote repo.

Environment:
  COTAL_FEEDBACK_SSH          Default: cotal@63.143.44.130
  COTAL_FEEDBACK_REMOTE_ROOT  Default: /home/cotal/SWARL
`);
}

function quote(s) {
  return `'${String(s).replaceAll("'", `'"'"'`)}'`;
}

function run(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  usage();
  process.exit(0);
}

if (cmd === "health") {
  run(["curl", "-fsS", "https://broker.cotal.ai/health"]);
}

if (cmd === "ssh") {
  run(["ssh", host, `cd ${quote(remoteRoot)} && exec \${SHELL:-/bin/bash}`]);
}

const remote = `export PATH=\"$HOME/.local/bin:$PATH\"; cd ${quote(remoteRoot)} && scripts/feedback-admin.mjs ${[cmd, ...args].map(quote).join(" ")}`;
run(["ssh", host, remote]);
