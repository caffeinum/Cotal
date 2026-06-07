import React from "react";
import { Box, Text } from "ink";
import type { RosterEntry } from "../mesh.js";
import { agentColor, STATUS, ago, focusBorder } from "./theme.js";

/** Always-visible left panel: who's present, sorted by salience, with live status + activity. */
export function Roster({
  entries,
  focused,
  width,
  height,
}: {
  entries: RosterEntry[];
  focused: boolean;
  width: number;
  height: number;
}): React.ReactElement {
  const agents = entries.filter((e) => e.isAgent);
  const endpoints = entries.filter((e) => !e.isAgent);
  // Reserve rows for the border (2) + title (1); clip the rest.
  const room = Math.max(1, height - 3);
  const rows = [...agents, ...endpoints].slice(0, room);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={focusBorder(focused)}
      paddingX={1}
    >
      <Text bold>
        Roster <Text dimColor>{agents.length}</Text>
      </Text>
      {rows.length === 0 && <Text dimColor>(nobody present)</Text>}
      {rows.map((e) => (
        <RosterRow key={e.card.id} entry={e} />
      ))}
    </Box>
  );
}

const RosterRow = React.memo(function RosterRow({ entry }: { entry: RosterEntry }): React.ReactElement {
  const { card, status, activity, ageMs, isAgent } = entry;
  const name = card.name.slice(0, 14);
  if (!isAgent) {
    return (
      <Text wrap="truncate-end">
        <Text color="gray">⚙ </Text>
        <Text dimColor>{name}</Text>
        {activity ? <Text dimColor> {activity}</Text> : null}
      </Text>
    );
  }
  const s = STATUS[status];
  return (
    <Text wrap="truncate-end">
      <Text color={s.color}>{s.dot} </Text>
      <Text color={agentColor(card.name)}>{name}</Text>
      {activity ? <Text dimColor> {activity}</Text> : null}
      <Text dimColor> {ago(ageMs)}</Text>
    </Text>
  );
});
