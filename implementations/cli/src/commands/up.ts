import { spawn } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  statSync,
  readSync,
  closeSync,
} from "node:fs";
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
import { resolveSpace } from "../lib/status.js";
import { c } from "../ui.js";
import { resolveNatsServer } from "../lib/nats-bin.js";

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
      detach: { type: "boolean" }, // run the server in the background (pid in .cotal/nats.pid)
    },
  });
  const server = values.server ?? DEFAULT_SERVER;
  if (await isReachable(server)) {
    console.log(c.green(`✓ NATS already running at ${server}`));
    return;
  }

  if (values.detach) {
    const { pid, source } = await startMeshDetached({
      server,
      storeDir: values["store-dir"],
      space: values.space,
      open: values.open,
      channels: values.channels,
    });
    console.log(c.dim(`Started nats-server (${source}).`));
    console.log(c.green(`✓ mesh running in the background (pid ${pid}) — stop with: cotal down`));
    return;
  }

  const storeDir = resolve(values["store-dir"] ?? ".cotal/nats");
  mkdirSync(storeDir, { recursive: true });
  const useAuth = !values.open;
  const space = values.space ?? resolveSpace(process.cwd());
  const seedFile = loadChannelsFile(values.channels);
  const setup = useAuth ? await authSetup(storeDir, server, space) : undefined;
  const port = Number(new URL(server).port) || 4222;
  const args = setup ? ["-c", setup.confPath] : ["-js", "-sd", storeDir, "-p", String(port)];
  const { bin, source } = await resolveNatsServer();

  console.log(
    c.dim(
      `Starting nats-server (JetStream, ${useAuth ? "JWT auth" : "OPEN/no-auth"}, ${source}) — store: ${storeDir}`,
    ),
  );
  console.log(c.dim("Press Ctrl-C to stop.\n"));
  const child = spawn(bin, args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    process.exit(1);
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));

  if (await waitReady(server, setup?.creds)) {
    await postStart(server, space, setup, seedFile);
  }
  await new Promise<void>(() => {});
}

export interface DetachOpts {
  server?: string;
  storeDir?: string;
  space?: string;
  open?: boolean;
  channels?: string;
  /** Live boot lines, tailed from the server's log file (safe for a detached child). */
  onLine?: (line: string) => void;
}

/**
 * Start a background nats-server (JetStream), wait until it's reachable, pre-create the
 * space's streams, and leave it running detached (pid in `.cotal/nats.pid`). Shared by
 * `up --detach` and `cotal setup`. When `onLine` is given, boot output is tailed from the
 * log file and forwarded — the child writes to the file (not a pipe), so it survives the
 * parent exiting.
 */
export async function startMeshDetached(opts: DetachOpts = {}): Promise<{ server: string; pid: number; source: string }> {
  const server = opts.server ?? DEFAULT_SERVER;
  const storeDir = resolve(opts.storeDir ?? ".cotal/nats");
  mkdirSync(storeDir, { recursive: true });
  const useAuth = !opts.open;
  const space = opts.space ?? resolveSpace(process.cwd());
  const seedFile = loadChannelsFile(opts.channels);
  const setup = useAuth ? await authSetup(storeDir, server, space) : undefined;
  const port = Number(new URL(server).port) || 4222;
  const args = setup ? ["-c", setup.confPath] : ["-js", "-sd", storeDir, "-p", String(port)];
  const { bin, source } = await resolveNatsServer();

  const logPath = resolve(".cotal/nats.log");
  const startOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  const fd = openSync(logPath, "a");
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();

  let tailing = Boolean(opts.onLine);
  if (opts.onLine) tailLines(logPath, startOffset, opts.onLine, () => !tailing);

  const ready = await waitReady(server, setup?.creds);
  tailing = false;
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(`nats-server did not become reachable at ${server} — see ${logPath}`);
  }
  writeFileSync(resolve(".cotal/nats.pid"), String(child.pid));
  await postStart(server, space, setup, seedFile);
  return { server, pid: child.pid ?? 0, source };
}

/** Poll a growing log file and forward newly-appended lines until `stopped()` is true. */
function tailLines(path: string, from: number, onLine: (l: string) => void, stopped: () => boolean): void {
  let offset = from;
  const tick = () => {
    if (stopped()) return;
    try {
      const size = statSync(path).size;
      if (size > offset) {
        const fd = openSync(path, "r");
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        for (const line of buf.toString("utf8").split("\n")) if (line.trim()) onLine(line);
      }
    } catch {
      // file may not exist yet on the first ticks — keep polling
    }
    setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
}

async function waitReady(server: string, creds?: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(server, creds ? { creds } : undefined)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** One-time space infrastructure once the server accepts connections: pre-create the
 *  streams agents are denied STREAM.CREATE for (auth mode), and seed the channel registry. */
async function postStart(
  server: string,
  space: string,
  setup?: { creds: string },
  seedFile?: ChannelRegistryFile,
): Promise<void> {
  if (setup) {
    await setupSpaceStreams({ servers: server, space, creds: setup.creds });
  }
  if (seedFile) {
    await seedChannelRegistry({ servers: server, space, creds: setup?.creds, file: seedFile });
  }
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
  }
  const port = Number(new URL(server).port) || 4222;
  const confPath = resolve(dir, "server.conf");
  writeFileSync(confPath, serverConfig(auth, { port, storeDir }));
  const creds = await mintCreds(auth, newIdentity(), "manager"); // privileged, ephemeral
  return { confPath, creds };
}
