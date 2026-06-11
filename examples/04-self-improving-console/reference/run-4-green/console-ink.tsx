import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { render } from "ink";
import { CotalEndpoint, isReachable, DEFAULT_SERVER, chatWildcard } from "@cotal-ai/core";
import { c } from "../ui.js";
import { runLog } from "../render.js";
import { App } from "../console/app.js";

/**
 * `cotal console-ink` — the Ink/React rebuild of the live console.
 *
 * A lazygit-style TUI: roster + channel tabs + live feed + multi-panel focus + a
 * context-sensitive `?` help overlay. It reads via the same read-only `CotalEndpoint`
 * observer as the classic `console` (invisible to peers); the data layer is backend's
 * `useMesh()` hook, which owns the endpoint's start/tap/stop lifecycle.
 */
export async function consoleInk(argv: string[]): Promise<void> {
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
  // Built UNSTARTED: useMesh() owns start()/tap()/stop() and drives status.connected.
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

  // Under auth the observer may only tap chat.> (DM/anycast stay confidential); open mode taps all.
  const tapSubject = creds ? chatWildcard(space) : undefined;

  // No TTY (piped / headless) → the classic plain log; the Ink app needs a real terminal.
  if (values.plain || process.stdout.isTTY !== true) {
    await runLog(ep, space, tapSubject);
    return;
  }

  const { waitUntilExit } = render(<App ep={ep} space={space} tapSubject={tapSubject} />, {
    maxFps: 30,
    incrementalRendering: true,
  });
  await waitUntilExit();
}
