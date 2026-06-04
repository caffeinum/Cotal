/**
 * Swarl lifecycle hook — a stateless relay.
 *
 * Claude Code runs this on a lifecycle event and pipes the event JSON (which
 * includes `hook_event_name`) on stdin. We forward it to this session's
 * connector over its local control socket and print the reply for Claude Code
 * to apply. It must NEVER block the session: any error → exit 0, no output.
 */
import { connect } from "node:net";
import { configFromEnv } from "./config.js";
import { controlSocketPath } from "./runtime.js";

const TIMEOUT_MS = 2000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(d));
  });
}

function done(out: string): never {
  const t = out.trim();
  if (t) process.stdout.write(t + "\n");
  process.exit(0); // fail open — a connector that's down or slow never blocks Claude
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim() || "{}";
  const cfg = configFromEnv();
  const sock = connect(controlSocketPath(cfg.space, cfg.name));

  let reply = "";
  let settled = false;
  const finish = (out: string): void => {
    if (settled) return;
    settled = true;
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
    done(out);
  };
  const timer = setTimeout(() => finish(""), TIMEOUT_MS);

  sock.setEncoding("utf8");
  sock.on("connect", () => sock.write(raw + "\n"));
  sock.on("data", (d) => {
    reply += d;
    const nl = reply.indexOf("\n");
    if (nl >= 0) {
      clearTimeout(timer);
      finish(reply.slice(0, nl));
    }
  });
  sock.on("error", () => {
    clearTimeout(timer);
    finish(""); // connector not running — no-op
  });
  sock.on("end", () => {
    clearTimeout(timer);
    finish(reply);
  });
}

main().catch(() => done(""));
