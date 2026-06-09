import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  mintCreds,
  newIdentity,
  setupSpaceStreams,
  seedChannelRegistry,
  type SpaceAuth,
  type ChannelRegistryFile,
} from "@cotal-ai/core";
import { c } from "../ui.js";

export async function up(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "store-dir": { type: "string" },
      space: { type: "string" },
      open: { type: "boolean" }, // disable auth — run an open dev mesh
      channels: { type: "string" }, // seed the channel registry from this JSON file
    },
  });
  const server = values.server ?? DEFAULT_SERVER;
  if (await isReachable(server)) {
    console.log(c.green(`✓ NATS already running at ${server}`));
    return;
  }
  const storeDir = resolve(values["store-dir"] ?? ".cotal/nats");
  mkdirSync(storeDir, { recursive: true });

  // Secure by default: start the server in decentralized-JWT mode so agents must present
  // minted creds. `--open` runs the unauthenticated dev mesh instead.
  const useAuth = !values.open;
  const space = values.space ?? "demo";
  const seedFile = loadChannelsFile(values.channels);
  const setup = useAuth ? await authSetup(storeDir, server, space) : undefined;
  const args = setup ? ["-c", setup.confPath] : ["-js", "-sd", storeDir];

  console.log(
    c.dim(
      useAuth
        ? `Starting nats-server (JetStream, JWT auth) — store: ${storeDir}`
        : `Starting nats-server (JetStream, OPEN/no-auth) — store: ${storeDir}`,
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

  // Auth mode: streams are space infrastructure that agents are denied STREAM.CREATE for,
  // so pre-create them here (once, privileged) as soon as the server accepts connections.
  if (setup) {
    for (let i = 0; i < 50; i++) {
      if (await isReachable(server, { creds: setup.creds })) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await setupSpaceStreams({ servers: server, space, creds: setup.creds });
    console.log(c.dim("Pre-created CHAT/DM/TASK streams for the space."));
    if (seedFile) {
      await seedChannelRegistry({ servers: server, space, creds: setup.creds, file: seedFile });
      console.log(c.dim("Seeded the channel registry."));
    }
  } else if (seedFile) {
    // Open mode: the bucket is created lazily — wait for the server, then seed it (no creds).
    for (let i = 0; i < 50; i++) {
      if (await isReachable(server)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await seedChannelRegistry({ servers: server, space, file: seedFile });
    console.log(c.dim("Seeded the channel registry."));
  }
  await new Promise<void>(() => {});
}

/** Load the declarative channels-config file to seed the registry. An explicit `--channels`
 *  path that's missing is a hard error; the default `.cotal/channels.json` is optional (absent
 *  ⇒ nothing to seed). */
function loadChannelsFile(explicit?: string): ChannelRegistryFile | undefined {
  const path = resolve(explicit ?? ".cotal/channels.json");
  if (!existsSync(path)) {
    if (explicit) {
      console.error(c.red(`channels file not found: ${path}`));
      process.exit(1);
    }
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as ChannelRegistryFile;
}

/** Ensure the space's trust material exists, render a server config, and mint a privileged
 *  setup creds (used to pre-create streams once the server is up). The account signing key
 *  in `.cotal/auth` is what `cotal mint` and the manager later use to issue per-agent creds. */
async function authSetup(
  storeDir: string,
  server: string,
  space: string,
): Promise<{ confPath: string; creds: string }> {
  const dir = authDir(process.cwd());
  let auth: SpaceAuth | undefined = loadSpaceAuth(dir);
  if (!auth) {
    auth = await createSpaceAuth(space);
    saveSpaceAuth(dir, auth);
    console.log(c.dim(`Generated space auth for "${space}" → ${dir}/auth.json (keep the signing key safe)`));
  }
  const port = Number(new URL(server).port) || 4222;
  const confPath = resolve(dir, "server.conf");
  writeFileSync(confPath, serverConfig(auth, { port, storeDir }));
  const creds = await mintCreds(auth, newIdentity(), "manager"); // privileged, ephemeral
  return { confPath, creds };
}
