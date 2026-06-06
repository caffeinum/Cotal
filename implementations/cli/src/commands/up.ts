import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  isReachable,
  DEFAULT_SERVER,
  authDir,
  createSpaceAuth,
  loadSpaceAuth,
  saveSpaceAuth,
  serverConfig,
} from "@swarl/core";
import { c } from "../ui.js";

export async function up(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "store-dir": { type: "string" },
      space: { type: "string" },
      auth: { type: "boolean" },
    },
  });
  const server = values.server ?? DEFAULT_SERVER;
  if (await isReachable(server)) {
    console.log(c.green(`✓ NATS already running at ${server}`));
    return;
  }
  const storeDir = resolve(values["store-dir"] ?? ".swarl/nats");
  mkdirSync(storeDir, { recursive: true });

  // Auth mode (opt-in): start the server in decentralized-JWT mode so agents must present
  // minted creds. Without --auth the server stays open — the default dev path, and the
  // pre-cutover state for the whole identity/ACL feature.
  const args = values.auth
    ? await authArgs(storeDir, server, values.space ?? "demo")
    : ["-js", "-sd", storeDir];

  console.log(
    c.dim(
      values.auth
        ? `Starting nats-server (JetStream, JWT auth) — store: ${storeDir}`
        : `Starting nats-server (JetStream) — store: ${storeDir}`,
    ),
  );
  console.log(c.dim("Press Ctrl-C to stop.\n"));
  const child = spawn("nats-server", args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    console.error(c.dim("Install it with: brew install nats-server"));
    process.exit(1);
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
  await new Promise<void>(() => {});
}

/** Ensure the space's trust material exists, render a server config, and return the
 *  `nats-server -c <config>` args. The account signing key in `.swarl/auth` is what
 *  `swarl mint` and the manager later use to issue per-agent creds. */
async function authArgs(storeDir: string, server: string, space: string): Promise<string[]> {
  const dir = authDir(process.cwd());
  let auth = loadSpaceAuth(dir);
  if (!auth) {
    auth = await createSpaceAuth(space);
    saveSpaceAuth(dir, auth);
    console.log(c.dim(`Generated space auth for "${space}" → ${dir}/auth.json (keep the signing key safe)`));
  }
  const port = Number(new URL(server).port) || 4222;
  const confPath = resolve(dir, "server.conf");
  writeFileSync(confPath, serverConfig(auth, { port, storeDir }));
  return ["-c", confPath];
}
