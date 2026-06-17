#!/usr/bin/env node
/**
 * `npx @cotal-ai/connector-hermes install`
 *
 * Guided install of the Cotal plugin into an existing Hermes so its gateway can join a Cotal mesh.
 * Copies this package's `plugin/cotal` (incl. the bundled `_sidecar/standalone.cjs`) into
 * `<HERMES_HOME>/plugins/cotal`, enables it, optionally writes your mesh config to
 * `<HERMES_HOME>/.env`, and checks the mesh is reachable.
 *
 * Interactive when run in a TTY; non-interactive with `--yes` (or no TTY), taking config from
 * `--link/--space/--name/--server` flags or the matching `COTAL_*` env vars.
 *
 * House rule: no fallbacks. If Hermes isn't installed we fail loudly and write NOTHING.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_SRC = join(PKG_ROOT, "plugin", "cotal");
const SIDECAR = join(PLUGIN_SRC, "_sidecar", "standalone.cjs");

const DEFAULTS = { space: "demo", name: "my-hermes", server: "nats://127.0.0.1:4222" };

const die = (msg) => {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
};
const info = (msg) => process.stdout.write(`${msg}\n`);

function usage() {
  info("usage: npx @cotal-ai/connector-hermes install [--yes] [--link <url> | --space <s> --name <n> --server <url>]");
}

// ---- arg parsing ------------------------------------------------------------
function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      f[k] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    }
  }
  return f;
}

// ---- mesh config gathering --------------------------------------------------
async function promptConfig() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    info("\nCotal mesh — paste a join link (cotal://token@host/space), or press Enter to set it manually:");
    const link = (await rl.question("  link: ")).trim();
    if (link) {
      const name = (await rl.question(`  name [${DEFAULTS.name}]: `)).trim() || DEFAULTS.name;
      return { COTAL_LINK: link, COTAL_NAME: name };
    }
    const space = (await rl.question(`  space  [${DEFAULTS.space}]: `)).trim() || DEFAULTS.space;
    const name = (await rl.question(`  name   [${DEFAULTS.name}]: `)).trim() || DEFAULTS.name;
    const server = (await rl.question(`  server [${DEFAULTS.server}]: `)).trim() || DEFAULTS.server;
    return { COTAL_SPACE: space, COTAL_NAME: name, COTAL_SERVERS: server };
  } finally {
    rl.close();
  }
}

function configFromFlags(flags) {
  const link = flags.link || process.env.COTAL_LINK;
  if (link) return { COTAL_LINK: link, COTAL_NAME: flags.name || process.env.COTAL_NAME || DEFAULTS.name };
  const space = flags.space || process.env.COTAL_SPACE;
  const server = flags.server || process.env.COTAL_SERVERS;
  if (!space && !server) return {}; // nothing supplied → skip .env, print manual next steps
  return {
    COTAL_SPACE: space || DEFAULTS.space,
    COTAL_NAME: flags.name || process.env.COTAL_NAME || DEFAULTS.name,
    COTAL_SERVERS: server || DEFAULTS.server,
  };
}

// ---- ~/.hermes/.env editing (idempotent) ------------------------------------
function writeEnv(file, set) {
  // Link mode and manual mode are mutually exclusive; comment out the other mode's keys so a
  // re-run never leaves a stale COTAL_SPACE overriding a new COTAL_LINK (individual vars win in
  // configFromEnv).
  const drop = set.COTAL_LINK ? ["COTAL_SPACE", "COTAL_SERVERS"] : ["COTAL_LINK"];
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const keyOf = (l) => l.replace(/^#\s*/, "").split("=")[0].trim();
  for (const [k, v] of Object.entries(set)) {
    const line = `${k}=${v}`;
    const i = lines.findIndex((l) => keyOf(l) === k);
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  for (let i = 0; i < lines.length; i++) {
    if (drop.includes(keyOf(lines[i])) && !lines[i].trimStart().startsWith("#")) lines[i] = `# ${lines[i]}`;
  }
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}

// ---- mesh reachability ------------------------------------------------------
function hostPort(server) {
  try {
    const u = new URL(server.replace(/^(cotals?|nats):\/\//, "http://"));
    return { host: u.hostname, port: Number(u.port || 4222) };
  } catch {
    return undefined;
  }
}
function reachable(server) {
  const hp = hostPort(server);
  if (!hp) return Promise.resolve(false);
  return new Promise((res) => {
    const s = createConnection({ host: hp.host, port: hp.port });
    const done = (ok) => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      res(ok);
    };
    s.setTimeout(2000);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

// ---- main -------------------------------------------------------------------
const args = process.argv.slice(2);
if (args[0] !== "install") {
  usage();
  process.exit(args[0] ? 1 : 0);
}
const flags = parseFlags(args.slice(1));

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
if (!existsSync(SIDECAR)) {
  die(
    `bundled sidecar missing at ${SIDECAR}\n` +
      "  (running from source? build it first: pnpm --filter @cotal-ai/connector-hermes build)",
  );
}
info(`✓ Hermes detected — ${version.split("·")[0].trim()}`);

const hermesHome = process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
const interactive = Boolean(process.stdin.isTTY) && !flags.yes;
const meshEnv = interactive ? await promptConfig() : configFromFlags(flags);

// Write mesh config to <home>/.env (if any was gathered).
if (Object.keys(meshEnv).length) {
  const envFile = join(hermesHome, ".env");
  mkdirSync(hermesHome, { recursive: true });
  writeEnv(envFile, meshEnv);
  info(`✓ Wrote ${Object.keys(meshEnv).join(", ")} to ${envFile}`);

  // Best-effort reachability check.
  const server = meshEnv.COTAL_SERVERS || meshEnv.COTAL_LINK;
  if (server) {
    const ok = await reachable(server);
    info(ok ? `✓ Mesh reachable` : `✗ Mesh not reachable at ${hostPort(server)?.host}:${hostPort(server)?.port} — start it (e.g. \`nats-server -js\`) before \`hermes gateway run\``);
  }
}

// Copy the plugin + enable it.
const pluginsDir = join(hermesHome, "plugins");
const dest = join(pluginsDir, "cotal");
mkdirSync(pluginsDir, { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(PLUGIN_SRC, dest, {
  recursive: true,
  filter: (src) => !src.includes(`${sep}__pycache__`) && !src.endsWith(".pyc"),
});
try {
  execFileSync("hermes", ["plugins", "enable", "cotal"], { stdio: "inherit" });
} catch {
  die(
    "copied the plugin but `hermes plugins enable cotal` failed.\n" +
      "  Enable it manually: `hermes plugins enable cotal`.",
  );
}

info("\n✓ Cotal plugin installed + enabled.\n");
if (Object.keys(meshEnv).length) {
  info("Run it on the mesh:");
  info("  hermes gateway run");
} else {
  info("Next: set your mesh in ~/.hermes/.env (COTAL_LINK, or COTAL_SPACE/COTAL_NAME/COTAL_SERVERS),");
  info("  then: hermes gateway run");
}
