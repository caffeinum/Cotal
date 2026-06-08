import { Box, Text } from "ink";
import type { MeshState } from "../mesh.js";

/** Bottom bar: connection + space + active channel + msgs/s, then context keybindings. */
export function StatusBar({
  status,
  rates,
  activeChannel,
  agentCount,
  focusedId,
  width,
}: {
  status: MeshState["status"];
  rates: MeshState["rates"];
  activeChannel: string;
  agentCount: number;
  focusedId: "roster" | "feed";
  width: number;
}) {
  const keys =
    focusedId === "feed"
      ? "↑↓ select · Enter detail · / search · ←→ panel · 1-9 chan · ? help · q quit"
      : "↑↓ select · Enter detail · / search · ←→ panel · 1-9 chan · ? help · q quit";
  return (
    <Box width={width} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={status.connected ? "green" : "red"}>{status.connected ? "● " : "⨯ "}</Text>
        <Text dimColor>
          {status.space + " · #" + activeChannel + " · " + agentCount + " agents · " +
            rates.msgsPerSec.toFixed(1) + " msg/s"}
        </Text>
        {status.dmVisible ? null : <Text color="yellow">{"  chat-only"}</Text>}
        {status.error ? (
          <Text color="red">{"  ! " + status.error}</Text>
        ) : (
          <Text dimColor>{"   " + keys}</Text>
        )}
      </Text>
    </Box>
  );
}
