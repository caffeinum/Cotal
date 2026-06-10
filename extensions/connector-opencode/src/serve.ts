/**
 * Launcher shim for the OpenCode connector.
 *
 * `opencode serve` loads plugins lazily — on the first HTTP request, not at boot — so a
 * supervised, client-less server would never load the Cotal plugin and so never join the
 * mesh. And `--port 0` falls back to the fixed default (4096), which collides when several
 * peers run on one host. This shim fixes both: it picks a free port, starts the server on
 * it, and polls it until ready to force the plugin (and the mesh join) to initialize.
 *
 * SECURITY: `opencode serve` is UNAUTHENTICATED by default — the CVE-2026-22812 surface
 * (any local process, or a malicious site via DNS-rebind, can drive the session: arbitrary
 * code execution as this user + full mesh-identity takeover via the ungated cotal_* tools).
 * So we set a random per-launch `OPENCODE_SERVER_PASSWORD` in the child env and present it
 * as HTTP basic auth on the poke. The in-process plugin is server-side and unaffected; the
 * password only gates EXTERNAL HTTP callers. Bind stays loopback; no CORS / mDNS.
 *
 * Otherwise it just supervises — forwards the child's stdio + signals and exits with its code.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

const BIN = process.env.COTAL_OPENCODE_BIN?.trim() || "opencode";

/** Per-launch secret gating the spawned server's HTTP API (see SECURITY above). */
const SECRET = randomBytes(24).toString("hex");

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
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: SECRET },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Poll the server until a 2xx to force plugin load (and the mesh join). Polling — rather than a
  // single fire-and-forget GET keyed off a stderr banner + fixed delay — means a slow start or a
  // changed startup log can't leave the agent silently un-joined.
  const auth = `Basic ${Buffer.from(`opencode:${SECRET}`).toString("base64")}`;
  let poked = false;
  const poke = async (): Promise<void> => {
    if (poked) return;
    poked = true;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/session`, { headers: { authorization: auth } });
        if (res.ok) return; // server up + plugin loaded
      } catch {
        /* server not up yet — retry */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    process.stderr.write("[cotal-connector] serve: no 2xx from the poke after ~10s — plugin may not have loaded\n");
  };

  child.stdout.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
  void poke();

  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

void main();
