import { Box, Text } from "ink";

type FocusId = "roster" | "channels" | "feed";

const GLOBAL: ReadonlyArray<readonly [string, string]> = [
  ["Tab / Shift+Tab", "cycle focus between panels"],
  ["1 – 9", "jump to a channel tab"],
  ["← / →", "previous / next tab"],
  ["a / 0", "all-traffic tab"],
  ["?", "toggle this help"],
  ["q / Ctrl-C", "quit"],
];

const CONTEXT: Record<FocusId, ReadonlyArray<readonly [string, string]>> = {
  feed: [
    ["↑ / ↓", "scroll one line"],
    ["PgUp / PgDn", "scroll one page"],
    ["g / G", "jump to oldest / newest (follow)"],
  ],
  channels: [
    ["1 – 9", "select a channel tab"],
    ["← / →", "move between tabs"],
  ],
  roster: [["—", "presence is live; this panel has no actions"]],
};

function KeyRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <Box>
      <Box width={18}>
        <Text color="yellow">{keys}</Text>
      </Box>
      <Text dimColor>{desc}</Text>
    </Box>
  );
}

/** Context-sensitive help overlay — global keys plus those for the focused panel. */
export function Help({ focus }: { focus: FocusId }) {
  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={3} paddingY={1}>
        <Text bold>cotal console-ink — keys</Text>
        <Box marginTop={1} flexDirection="column">
          {GLOBAL.map(([k, d]) => (
            <KeyRow key={k} keys={k} desc={d} />
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">
            {focus} panel
          </Text>
          {CONTEXT[focus].map(([k, d]) => (
            <KeyRow key={k} keys={k} desc={d} />
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>press ? or esc to close</Text>
        </Box>
      </Box>
    </Box>
  );
}
