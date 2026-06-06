/**
 * Launch a `claude` session as a Swarl mesh peer from a local agent file — the
 * no-manager path. Resolves <name-or-path> to an agent definition, runs it through
 * the connector's buildLaunch (the single source of truth for the launch recipe),
 * and execs `claude` in the foreground. The manager uses the very same path under
 * its supervised runtime — this is just an unsupervised, one-shot caller.
 *
 *   pnpm tsx scripts/spawn.ts <name-or-path> [--space <s>] [--server <url>]
 *
 * Prereqs: mesh up (`pnpm swarl up`) and the plugin installed once:
 *   claude plugin install swarl@swarl-mesh --scope local
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { DEFAULT_SERVER, agentFilePath, loadAgentFile } from "@swarl/core";
import { claudeConnector } from "@swarl/connector";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { space: { type: "string" }, server: { type: "string" } },
});

const ref = positionals[0];
if (!ref) {
  console.error("usage: pnpm tsx scripts/spawn.ts <name-or-path> [--space <s>] [--server <url>]");
  process.exit(1);
}

const path = agentFilePath(process.cwd(), ref);
const def = loadAgentFile(path); // validate + get name/role for the launch opts
const spec = claudeConnector.buildLaunch({
  space: values.space ?? "demo",
  name: def.name,
  role: def.role,
  servers: values.server ?? DEFAULT_SERVER,
  configPath: path,
});

console.error(
  `launching ${def.name}${def.role ? ` (${def.role})` : ""} on the mesh — press Enter at the dev-channels prompt`,
);
const child = spawn(spec.command, spec.args, {
  stdio: "inherit",
  env: { ...process.env, ...spec.env },
});
child.on("exit", (code) => process.exit(code ?? 0));
