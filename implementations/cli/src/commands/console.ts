import { parseArgs } from "node:util";
import { readFileSync, writeSync } from "node:fs";
import { createElement } from "react";
import { render } from "ink";
import { CotalEndpoint, isReachable, DEFAULT_SERVER, chatWildcard } from "@cotal/core";
import { c } from "../ui.js";
import { runLog } from "../render.js";
import { App } from "../console/app.js";

/**
 * `cotal console` — the live protocol view for a space. A real terminal gets the lazygit-style
 * Ink TUI (roster · channel tabs · live feed · detail · search); a pipe or `--plain` gets the
 * passive line stream. Both render over the SAME read-only observer (no new NATS connection):
 * the Ink app's `useMesh` hook owns the endpoint lifecycle (start → tap → stop), so this command
 * just builds the unstarted observer and renders. See docs/protocol-view.md.
 */
export async function console_(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      plain: { type: "boolean" },
      creds: { type: "string" },
    },
  });
  const space = values.space ?? "demo";
  const server = values.server ?? DEFAULT_SERVER;
  const creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm cotal up`));
    process.exit(1);
  }

  // Observer: never registers presence, never consumes an inbox — invisible to peers.
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: { name: "console", kind: "endpoint" },
  });
  ep.on("error", () => {});

  // Under auth the tap must narrow to chat.> (DMs/anycast stay confidential); open mode taps all.
  const tapSubject = creds ? chatWildcard(space) : undefined;

  // No TTY (piped/headless) or --plain → the passive line stream; Ink needs a real terminal.
  if (values.plain || process.stdout.isTTY !== true) {
    await runLog(ep, space, tapSubject);
    return;
  }

  // Full-screen takeover + mouse-wheel scroll: the alternate screen gives a clean app-like
  // canvas (and restores the user's scrollback on exit), and xterm alt-scroll (?1007h) makes the
  // wheel/trackpad emit ↑/↓ — which Ink delivers to useInput, so the feed's arrow-key scroll just
  // works. No SGR mouse parsing, no new deps.
  let restored = false;
  // Synchronous writes (fs.writeSync) so the sequences flush before the process exits — a plain
  // process.stdout.write over a TTY is async and gets truncated by process.exit() on a signal.
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      writeSync(process.stdout.fd, "\x1b[?1007l\x1b[?1049l\x1b[?25h"); // alt-scroll off, leave alt-screen, show cursor
    } catch {
      /* stdout already gone */
    }
  };
  writeSync(process.stdout.fd, "\x1b[?1049h\x1b[?1007h"); // enter alt-screen + alt-scroll before Ink's first frame
  process.once("exit", restore); // synchronous safety net for any exit path
  // External kill: restore the terminal, then actually exit (a bare handler would just hang).
  process.once("SIGINT", () => {
    restore();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    restore();
    process.exit(0);
  });

  const { waitUntilExit } = render(createElement(App, { ep, tapSubject }), {
    exitOnCtrlC: true,
    maxFps: 30,
    incrementalRendering: true,
  });
  await waitUntilExit();
  restore();
}
