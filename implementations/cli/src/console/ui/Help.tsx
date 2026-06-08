import { Box, Text } from "ink";

/** Context-sensitive `?` overlay: the focused panel's keys first, then the global ones. */
export function Help({
  focusedId,
  width,
  height,
}: {
  focusedId: "roster" | "feed";
  width: number;
  height: number;
}) {
  const panel: [string, string][] =
    focusedId === "feed"
      ? [
          ["↑ / ↓", "move selection"],
          ["PgUp / PgDn", "move a page"],
          ["g / G", "oldest / newest (follow)"],
          ["Enter", "open message detail"],
        ]
      : [
          ["↑ / ↓", "move selection"],
          ["Enter", "open agent detail"],
        ];
  const global: [string, string][] = [
    ["Tab / ← →", "switch panel"],
    ["1 – 9", "jump to channel tab"],
    ["/", "search / filter"],
    ["Esc", "clear filter / close"],
    ["?", "toggle this help"],
    ["q / Ctrl-C", "quit"],
  ];
  const section = (title: string, rows: [string, string][]) => (
    <Box marginTop={1} flexDirection="column">
      <Text bold>{title}</Text>
      {rows.map(([k, d], i) => (
        <Text key={i}>
          {"  "}
          <Text color="yellow">{k.padEnd(14)}</Text>
          <Text dimColor>{d}</Text>
        </Text>
      ))}
    </Box>
  );
  return (
    <Box
      width={width}
      height={height}
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Text bold color="cyan">
        cotal console — help
      </Text>
      <Text dimColor>{"context: " + focusedId + " panel"}</Text>
      {section(focusedId + " panel", panel)}
      {section("global", global)}
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}
