#!/usr/bin/env node
/**
 * `npx @cotal-ai/connector-hermes install`
 *
 * Installs the Cotal plugin into an existing Hermes so the gateway can join a Cotal mesh.
 * Copies this package's `plugin/cotal` (including the bundled `_sidecar/standalone.cjs`) into
 * `<HERMES_HOME>/plugins/cotal` and enables it.
 *
 * House rule: no fallbacks. If Hermes isn't installed we fail loudly and write NOTHING — no
 * orphaned `~/.hermes/plugins/`. We resolve the Hermes home honestly (HERMES_HOME first), never
 * assuming a fixed path.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_SRC = join(PKG_ROOT, "plugin", "cotal");
const SIDECAR = join(PLUGIN_SRC, "_sidecar", "standalone.cjs");

function die(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}
function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function usage() {
  info("usage: npx @cotal-ai/connector-hermes install");
  info("  Installs the Cotal plugin into your Hermes (HERMES_HOME or ~/.hermes).");
}

const cmd = process.argv[2];
if (cmd !== "install") {
  usage();
  process.exit(cmd ? 1 : 0);
}

// 1. Require a working Hermes — refuse (writing nothing) if absent.
function hermesVersion() {
  try {
    return execFileSync("hermes", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}
const version = hermesVersion();
if (!version) {
  die(
    "Hermes isn't installed (no `hermes` on PATH). Install it first:\n" +
      "    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash\n" +
      "  then re-run: npx @cotal-ai/connector-hermes install",
  );
}

// 2. The bundled sidecar must be present (it ships in the npm package; a raw source checkout
//    needs `pnpm --filter @cotal-ai/connector-hermes build` first). No silent half-install.
if (!existsSync(SIDECAR)) {
  die(
    `bundled sidecar missing at ${SIDECAR}\n` +
      "  (running from source? build it first: pnpm --filter @cotal-ai/connector-hermes build)",
  );
}

// 3. Resolve the Hermes home honestly: HERMES_HOME wins, else ~/.hermes.
const hermesHome = process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
const pluginsDir = join(hermesHome, "plugins");
const dest = join(pluginsDir, "cotal");

info(`Hermes: ${version}`);
info(`Installing the Cotal plugin into ${dest} ...`);
mkdirSync(pluginsDir, { recursive: true });
rmSync(dest, { recursive: true, force: true }); // clean reinstall (overwrite stale code)
cpSync(PLUGIN_SRC, dest, {
  recursive: true,
  filter: (src) => !src.includes(`${sep}__pycache__`) && !src.endsWith(".pyc"),
});

// 4. Enable it via Hermes' own command (it's discovered now that it's in plugins/).
try {
  execFileSync("hermes", ["plugins", "enable", "cotal"], { stdio: "inherit" });
} catch {
  die(
    "copied the plugin but `hermes plugins enable cotal` failed.\n" +
      "  Enable it manually: `hermes plugins enable cotal` (or add `cotal` to plugins.enabled in config.yaml).",
  );
}

info("\n✓ Cotal plugin installed + enabled.\n");
info("Next: point it at a mesh, then run the gateway:");
info("  # add to ~/.hermes/.env  (or the matching HERMES_HOME)");
info("  COTAL_SPACE=demo");
info("  COTAL_NAME=my-hermes");
info("  COTAL_SERVERS=nats://127.0.0.1:4222");
info("");
info("  hermes gateway run");
