import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { SwarlEndpoint, isReachable, DEFAULT_SERVER } from "@swarl/core";
import { c } from "../ui.js";
import { runLog, runDashboard } from "../render.js";

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
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm swarl up`));
    process.exit(1);
  }

  // Observer: never registers presence, never consumes an inbox — invisible to peers.
  const ep = new SwarlEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    registerPresence: false,
    watchPresence: true,
    card: { name: "console", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));

  // Dashboard needs a real terminal; piped/--plain falls back to the classic log.
  if (values.plain || process.stdout.isTTY !== true) await runLog(ep, space);
  else await runDashboard(ep, space);
}
