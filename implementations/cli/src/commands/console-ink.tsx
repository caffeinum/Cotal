import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { render } from "ink";
import { CotalEndpoint, isReachable, DEFAULT_SERVER, chatWildcard } from "@cotal/core";
import { c } from "../ui.js";
import { runLog } from "../render.js";
import { App } from "../console/app.js";

/**
 * `cotal console-ink` — the Ink/React rebuild of the live console: a lazygit-style TUI
 * (roster + channel tabs + live feed + multi-panel focus + `?` help) over the SAME read-only
 * observer as `console`. The Ink app's `useMesh` hook owns the endpoint lifecycle
 * (start → tap → stop), so this command just builds the unstarted observer and renders.
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

  // No TTY (piped/headless) or --plain → the classic scrolling log; Ink needs a real terminal.
  if (values.plain || process.stdout.isTTY !== true) {
    await runLog(ep, space, tapSubject);
    return;
  }

  const { waitUntilExit } = render(<App ep={ep} tapSubject={tapSubject} />, {
    exitOnCtrlC: true,
    maxFps: 30,
    incrementalRendering: true,
  });
  await waitUntilExit();
}
