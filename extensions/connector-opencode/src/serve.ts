/**
 * Launcher shim for the OpenCode connector.
 *
 * `opencode serve` loads plugins lazily — on the first HTTP request, not at boot — so a
 * supervised, client-less server would never load the Cotal plugin and so never join the
 * mesh. And `--port 0` falls back to the fixed default (4096), which collides when several
 * peers run on one host. This shim fixes both: it picks a free port, starts the server on
 * it, and pokes it once to force the plugin (and the mesh join) to initialize. Otherwise it
 * just supervises — forwards the child's stdio + signals and exits with its code. The mesh
 * integration itself lives entirely in the in-process plugin; this only nudges it awake.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

const BIN = process.env.COTAL_OPENCODE_BIN?.trim() || "opencode";

/** Ask the OS for a free port (bind :0, read it, release) so co-located peers don't collide. */
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function main(): Promise<void> {
  const port = process.env.COTAL_OPENCODE_PORT?.trim() || String(await freePort());
  const child = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", port], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let poked = false;
  const poke = (): void => {
    if (poked) return;
    poked = true;
    // Fire-and-forget GET to force opencode to create its instance and load plugins.
    void fetch(`http://127.0.0.1:${port}/session`, { method: "GET" }).catch(() => {});
  };
  const watch = (buf: Buffer, out: NodeJS.WriteStream): void => {
    out.write(buf);
    if (!poked && /listening on http/i.test(buf.toString())) setTimeout(poke, 200);
  };
  child.stdout.on("data", (d: Buffer) => watch(d, process.stdout));
  child.stderr.on("data", (d: Buffer) => watch(d, process.stderr));

  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

void main();
