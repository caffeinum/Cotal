import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import React, { useEffect, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  chatWildcard,
  type Presence,
} from "@cotal/core";
import { c } from "../ui.js";
import { runLog } from "../render.js";

/**
 * `cotal console-ink` — the Ink/React rebuild of the live console.
 *
 * This is the PLACEHOLDER the swarm replaces: it already wires the read-only
 * `CotalEndpoint` observer (same as the classic `console`) and renders a minimal
 * Ink app, so the command runs end-to-end while the real lazygit-style TUI
 * (roster + channel tabs + feed + focus + ? help) is built in src/console/.
 */
function Placeholder({ ep, space }: { ep: CotalEndpoint; space: string }): React.ReactElement {
  const { exit } = useApp();
  const [roster, setRoster] = useState<Presence[]>(ep.getRoster());
  const [seen, setSeen] = useState(0);

  useEffect(() => {
    const onRoster = (peers: Presence[]): void => setRoster(peers);
    ep.on("roster", onRoster);
    ep.tap(() => setSeen((n) => n + 1));
    return () => {
      ep.off("roster", onRoster);
    };
  }, [ep]);

  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>cotal console-ink · {space}</Text>
      <Text dimColor>placeholder — the swarm is rebuilding this as a lazygit-style TUI</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          agents online: {roster.length} · messages seen: {seen}
        </Text>
        {roster.map((p) => (
          <Text key={p.card.name}>
            {"• "}
            {p.card.name} <Text dimColor>{p.status}{p.activity ? ` — ${p.activity}` : ""}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>press q to quit</Text>
      </Box>
    </Box>
  );
}

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

  // No TTY (piped / headless) → the classic plain log; the Ink app needs a real terminal.
  if (values.plain || process.stdout.isTTY !== true) {
    await runLog(ep, space, creds ? chatWildcard(space) : undefined);
    return;
  }

  await ep.start();
  const { waitUntilExit } = render(<Placeholder ep={ep} space={space} />);
  await waitUntilExit();
  await ep.stop();
}
