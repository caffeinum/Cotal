/**
 * Swarl lifecycle hook relay — stateless.
 *
 * The agent runtime runs a hook on a lifecycle event and pipes the event JSON (which
 * includes `hook_event_name`) on stdin. We forward it to this session's connector over
 * its local control socket and print the reply for the runtime to apply. It must NEVER
 * block the session: any error → exit 0, no output. Both the Claude Code and Codex hook
 * entry points are one-liners over {@link runHookRelay}.
 */
import { connect } from "node:net";
import { configFromEnv, hasIdentity } from "./config.js";
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

function done(out: string): void {
  const t = out.trim();
  if (!t) return process.exit(0); // fail open — never blocks the session
  // Flush before exiting: stdout to a pipe is async, so exit()ing right after write() can
  // truncate a large reply. Exit from the write callback; a 1s backstop guarantees we still leave.
  process.stdout.write(t + "\n", () => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

/** Relay one hook event from stdin to the connector's control socket and print the reply. */
export async function runHookRelay(): Promise<void> {
  if (!hasIdentity()) return done(""); // plain session, not a managed one — no-op
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
