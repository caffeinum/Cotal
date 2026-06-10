/**
 * Launcher shim for the OpenCode connector — gives a spawned agent a *watchable* TUI bound to the
 * exact session it drives, using OpenCode's own client/server split:
 *
 *   1. start `opencode serve` (headless) on a free port, with the Cotal plugin loaded inline;
 *   2. poke it once so the lazily-loaded plugin initializes (joins the mesh, creates ONE session);
 *   3. the plugin announces that session's id on stderr (`[cotal-session] <id>`);
 *   4. launch a foreground `opencode attach <url> --session <id>` — the TUI opens straight onto the
 *      agent's session, and every turn the plugin drives (via `session.promptAsync`) renders live.
 *
 * The attach TUI is a pure viewer (it connects to the running server); its env strips the plugin
 * config + COTAL_* so it never loads a *second* mesh endpoint.
 *
 * SECURITY: `opencode serve` is UNAUTHENTICATED by default — the CVE-2026-22812 surface (any local
 * process, or a malicious site via DNS-rebind, can drive the session: arbitrary code execution as
 * this user + full mesh-identity takeover via the ungated cotal_* tools). So we set a random
 * per-launch `OPENCODE_SERVER_PASSWORD` in the child env; the poke and the attach TUI present it as
 * HTTP basic auth. Bind stays loopback; no CORS / mDNS.
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
  const url = `http://127.0.0.1:${port}`;
  const serve = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", port], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: SECRET },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Scan the server's output for the plugin's session handshake; forward boot logs to our stderr
  // until the TUI takes over the terminal (after that, drop them so they can't corrupt its display).
  let sessionId: string | undefined;
  let attached = false;
  let onSession: ((id: string) => void) | undefined;
  const scan = (d: Buffer): void => {
    if (!attached) process.stderr.write(d);
    if (!sessionId) {
      const m = d.toString().match(/\[cotal-session\] (\S+)/);
      if (m) {
        sessionId = m[1];
        onSession?.(sessionId);
      }
    }
  };
  serve.stdout?.on("data", scan);
  serve.stderr?.on("data", scan);
  serve.on("exit", (code, signal) => {
    if (!attached) process.exit(code ?? (signal ? 1 : 0)); // died before the TUI came up
  });

  // Poke the server (lazy plugin load → mesh join + session create). Polling — not a one-shot keyed
  // off a log banner — means a slow start can't leave the agent silently un-joined.
  const auth = `Basic ${Buffer.from(`opencode:${SECRET}`).toString("base64")}`;
  void (async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${url}/session`, { headers: { authorization: auth } });
        if (res.ok) return;
      } catch {
        /* not up yet — retry */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    process.stderr.write("[cotal-connector] serve: no 2xx from the poke after ~10s — plugin may not have loaded\n");
  })();

  // Wait for the agent's session, then attach a foreground TUI to it.
  const id = await new Promise<string | undefined>((resolve) => {
    if (sessionId) return resolve(sessionId);
    onSession = resolve;
    setTimeout(() => resolve(sessionId), 20_000);
  });
  if (!id) {
    process.stderr.write("[cotal-connector] serve: agent session never came up (~20s) — aborting\n");
    serve.kill("SIGTERM");
    process.exit(1);
  }

  const tuiEnv: NodeJS.ProcessEnv = { ...process.env, OPENCODE_SERVER_PASSWORD: SECRET };
  delete tuiEnv.OPENCODE_CONFIG_CONTENT; // a viewer, not a peer — must NOT load the plugin again
  for (const k of Object.keys(tuiEnv)) if (k.startsWith("COTAL_")) delete tuiEnv[k];
  attached = true;
  const tui = spawn(BIN, ["attach", url, "--session", id, "--password", SECRET], {
    env: tuiEnv,
    stdio: "inherit",
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      tui.kill(sig);
      serve.kill(sig);
    });
  tui.on("exit", (code, signal) => {
    serve.kill("SIGTERM"); // TUI closed → tear down the server
    process.exit(code ?? (signal ? 1 : 0));
  });
}

void main();
