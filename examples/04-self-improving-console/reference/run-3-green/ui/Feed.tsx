import React from "react";
import { Box, Text } from "ink";
import type { FeedEntry } from "../mesh.js";
import type { FeedLine } from "./feedlines.js";
import { agentColor, clock } from "./theme.js";

/** Main panel: the live message feed for the active tab. Auto-scrolls unless scrolled up. */
export function Feed({
  lines,
  width,
  height,
  focused,
  title,
  scroll,
  maxScroll,
}: {
  lines: FeedLine[];
  width: number;
  height: number;
  focused: boolean;
  title: string;
  scroll: number;
  maxScroll: number;
}): React.ReactElement {
  const empty = lines.length === 0;
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
    >
      <Box>
        <Text bold>{title}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          {scroll > 0 ? (
            <Text color="yellow">↑ {scroll} more · G to follow</Text>
          ) : maxScroll > 0 ? (
            <Text dimColor>following</Text>
          ) : null}
        </Box>
      </Box>
      {empty && <Text dimColor>(no messages yet — waiting for peer traffic)</Text>}
      {lines.map((line, i) =>
        line.type === "head" ? (
          <HeadRow key={`h${i}`} entry={line.entry} />
        ) : (
          <Text key={`b${i}`} wrap="truncate-end">
            {line.text}
          </Text>
        ),
      )}
    </Box>
  );
}

const HeadRow = React.memo(function HeadRow({ entry }: { entry: FeedEntry }): React.ReactElement {
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{clock(entry.ts)} </Text>
      <Sender name={entry.from.name} role={entry.from.role} />
      <Text dimColor> → </Text>
      <Target entry={entry} />
      <Text dimColor>: </Text>
    </Text>
  );
});

function Sender({ name, role }: { name: string; role?: string }): React.ReactElement {
  return (
    <Text>
      <Text color={agentColor(name)}>{name}</Text>
      {role && role !== name ? <Text dimColor>/{role}</Text> : null}
    </Text>
  );
}

function Target({ entry }: { entry: FeedEntry }): React.ReactElement {
  if (entry.kind === "multicast")
    return <Text color="cyan">#{entry.channel ?? "?"}</Text>;
  if (entry.kind === "anycast")
    return <Text color="magenta">@{entry.toService ?? "?"}</Text>;
  // unicast — one or more named recipients, with a fan-out multiplier when coalesced.
  const names = entry.toNames ?? [];
  return (
    <Text>
      {names.length === 0 ? (
        <Text dimColor>?</Text>
      ) : (
        names.map((n, i) => (
          <Text key={n}>
            {i > 0 ? <Text dimColor>, </Text> : null}
            <Text color={agentColor(n)}>{n}</Text>
          </Text>
        ))
      )}
      {entry.count > 1 ? <Text dimColor> ({entry.count}×)</Text> : null}
    </Text>
  );
}
