import { Box, Text } from "ink";
import { agentColor, STATUS, ago, focusBorder } from "./theme.js";
import type { AgentRow } from "./types.js";

function Row({ p, now }: { p: AgentRow; now: number }) {
  const s = STATUS[p.status];
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text color={s.color}>{s.dot} </Text>
          <Text color={agentColor(p.name)} bold>
            {p.name}
          </Text>
        </Box>
        <Text dimColor>{ago(p.lastSeenMs, now)}</Text>
      </Box>
      {p.activity ? (
        <Text dimColor wrap="truncate-end">
          {"  " + p.activity}
        </Text>
      ) : null}
    </Box>
  );
}

function EndpointRow({ p, now }: { p: AgentRow; now: number }) {
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text color="gray">⚙ </Text>
        <Text dimColor>{p.name}</Text>
      </Box>
      <Text dimColor>{ago(p.lastSeenMs, now)}</Text>
    </Box>
  );
}

/** Always-visible presence panel: coordinating agents on top, plain endpoints below. */
export function Roster({
  roster,
  focused,
  now,
  width,
}: {
  roster: AgentRow[];
  focused: boolean;
  now: number;
  width: number;
}) {
  const agents = roster.filter((p) => p.kind === "agent");
  const endpoints = roster.filter((p) => p.kind !== "agent");
  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      borderStyle="round"
      borderColor={focusBorder(focused)}
      paddingX={1}
    >
      <Text bold>
        Roster <Text dimColor>· {agents.length}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {agents.map((p) => (
          <Row key={p.id} p={p} now={now} />
        ))}
        {agents.length === 0 ? <Text dimColor>(no agents present)</Text> : null}
      </Box>
      {endpoints.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>observers</Text>
          {endpoints.map((p) => (
            <EndpointRow key={p.id} p={p} now={now} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
