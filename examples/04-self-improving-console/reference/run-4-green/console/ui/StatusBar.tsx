import { Box, Text } from "ink";

/** Bottom bar: connection + space + counts on the left, key hints on the right. */
export function StatusBar({
  connected,
  space,
  agents,
  msgs,
  focusLabel,
}: {
  connected: boolean;
  space: string;
  agents: number;
  msgs: number;
  focusLabel: string;
}) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text color={connected ? "green" : "yellow"}>{connected ? "● " : "◐ "}</Text>
        <Text bold>COTAL </Text>
        <Text dimColor>
          · {space} · {connected ? `${agents} agent${agents === 1 ? "" : "s"}` : "connecting…"} ·{" "}
          {msgs} msg{msgs === 1 ? "" : "s"}
        </Text>
      </Box>
      <Text dimColor>
        [{focusLabel}] tab cycle · 1-9 chan · ←/→ tabs · ↑/↓ scroll · ? help · q quit
      </Text>
    </Box>
  );
}
