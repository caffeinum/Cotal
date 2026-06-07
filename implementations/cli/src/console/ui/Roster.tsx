import { useEffect, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import type { Presence } from "@cotal/core";
import { agentColor, STATUS, ago } from "./theme.js";

function RosterRow({ p, selected }: { p: Presence; selected: boolean }) {
  const isAgent = p.card.kind === "agent";
  const s = STATUS[p.status];
  return (
    <Text wrap="truncate-end" inverse={selected}>
      <Text color={isAgent ? s.color : "gray"}>{isAgent ? s.dot : "⚙"} </Text>
      <Text color={isAgent ? agentColor(p.card.name) : undefined} dimColor={!isAgent}>
        {p.card.name}
      </Text>
      {p.activity ? <Text dimColor>{"  " + p.activity}</Text> : null}
      <Text dimColor>{"  " + ago(p.ts)}</Text>
    </Text>
  );
}

/** Always-visible roster: agents (status dot + color + activity + age) then endpoints (dimmed). */
export function Roster({
  agents,
  endpoints,
  boxWidth,
  boxHeight,
  helpOpen,
  onFocus,
}: {
  agents: Presence[];
  endpoints: Presence[];
  boxWidth: number;
  boxHeight: number;
  helpOpen: boolean;
  onFocus: (id: "roster" | "feed") => void;
}) {
  const { isFocused } = useFocus({ id: "roster" });
  useEffect(() => {
    if (isFocused) onFocus("roster");
  }, [isFocused, onFocus]);

  const list = [...agents, ...endpoints];
  const [sel, setSel] = useState(0);
  const selClamped = Math.min(sel, Math.max(0, list.length - 1));

  useInput(
    (_input, key) => {
      if (key.upArrow) setSel((v) => Math.max(0, v - 1));
      else if (key.downArrow) setSel((v) => Math.min(list.length - 1, v + 1));
    },
    { isActive: isFocused && !helpOpen },
  );

  const capacity = Math.max(1, boxHeight - 3); // border (2) + title (1)
  let start = 0;
  if (list.length > capacity) {
    start = Math.min(Math.max(0, selClamped - Math.floor(capacity / 2)), list.length - capacity);
  }
  const visible = list.slice(start, start + capacity);

  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={boxHeight}
      borderStyle="round"
      borderColor={isFocused ? "cyan" : "gray"}
      paddingX={1}
    >
      <Text wrap="truncate-end">
        <Text bold>roster</Text>
        <Text dimColor>
          {" · " + agents.length + " agent" + (agents.length === 1 ? "" : "s")}
        </Text>
        {endpoints.length ? <Text dimColor>{" · " + endpoints.length + " ep"}</Text> : null}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>(nobody present)</Text>
      ) : (
        visible.map((p, i) => (
          <RosterRow key={p.card.id} p={p} selected={isFocused && start + i === selClamped} />
        ))
      )}
    </Box>
  );
}
