import { Fragment, useEffect, useRef, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import type { FeedEntry } from "../mesh.js";
import { agentColor, fmtTime, wrapText } from "./theme.js";

type Row = { kind: "head"; entry: FeedEntry } | { kind: "body"; text: string };

function buildRows(entries: FeedEntry[], bodyWidth: number): Row[] {
  const rows: Row[] = [];
  for (const e of entries) {
    rows.push({ kind: "head", entry: e });
    for (const seg of wrapText(e.text, bodyWidth)) rows.push({ kind: "body", text: seg });
  }
  return rows;
}

function Target({ entry }: { entry: FeedEntry }) {
  if (entry.delivery === "multicast") return <Text color="cyan">#{entry.channel ?? "?"}</Text>;
  if (entry.delivery === "anycast") return <Text color="magenta">@{entry.toService ?? "?"}</Text>;
  const names = entry.toNames ?? [];
  return (
    <Text>
      {names.map((n, i) => (
        <Fragment key={i}>
          {i > 0 ? <Text dimColor>, </Text> : null}
          <Text color={agentColor(n)}>{n}</Text>
        </Fragment>
      ))}
      {entry.count && entry.count > 1 ? <Text dimColor>{" (" + entry.count + "×)"}</Text> : null}
    </Text>
  );
}

function HeadRow({ entry }: { entry: FeedEntry }) {
  const role = entry.from.role;
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{fmtTime(entry.ts) + " "}</Text>
      <Text color={agentColor(entry.from.name)}>{entry.from.name}</Text>
      {role && role !== entry.from.name ? <Text dimColor>{"/" + role}</Text> : null}
      <Text dimColor> → </Text>
      <Target entry={entry} />
      <Text dimColor>:</Text>
    </Text>
  );
}

/**
 * The live message feed — main panel. Coalesced + windowed entries from useMesh, filtered to
 * the active channel (`all` = firehose incl. unicast/anycast). Hand-rolled scroll viewport:
 * follows the tail unless the user scrolls up; Ink has no scroll view, so we slice rows to fit.
 */
export function Feed({
  entries,
  activeChannel,
  boxWidth,
  boxHeight,
  helpOpen,
  onFocus,
}: {
  entries: FeedEntry[];
  activeChannel: string;
  boxWidth: number;
  boxHeight: number;
  helpOpen: boolean;
  onFocus: (id: "roster" | "feed") => void;
}) {
  const { isFocused } = useFocus({ id: "feed" });
  useEffect(() => {
    if (isFocused) onFocus("feed");
  }, [isFocused, onFocus]);

  const filtered =
    activeChannel === "all"
      ? entries
      : entries.filter((e) => e.delivery === "multicast" && e.channel === activeChannel);

  const room = Math.max(1, boxHeight - 3); // border (2) + title (1)
  const rows = buildRows(filtered, Math.max(8, boxWidth - 4 - 3)); // pad/border (4) + indent (3)
  const maxScroll = Math.max(0, rows.length - room);
  const clamp = (v: number) => Math.max(0, Math.min(v, maxScroll));

  const [scroll, setScroll] = useState(0);
  const prevLen = useRef(0);

  // Stay anchored to the same content as new rows arrive while scrolled up.
  useEffect(() => {
    const grew = rows.length - prevLen.current;
    if (scroll > 0 && grew > 0) {
      setScroll((s) => Math.max(0, Math.min(s + grew, Math.max(0, rows.length - room))));
    }
    prevLen.current = rows.length;
  }, [rows.length, room, scroll]);

  // Snap to the tail when the channel filter changes.
  useEffect(() => {
    setScroll(0);
  }, [activeChannel]);

  useInput(
    (input, key) => {
      if (key.upArrow) setScroll((s) => clamp(s + 1));
      else if (key.downArrow) setScroll((s) => clamp(s - 1));
      else if (key.pageUp) setScroll((s) => clamp(s + (room - 1)));
      else if (key.pageDown) setScroll((s) => clamp(s - (room - 1)));
      else if (input === "g" || key.home) setScroll(clamp(maxScroll));
      else if (input === "G" || key.end) setScroll(0);
    },
    { isActive: isFocused && !helpOpen },
  );

  const end = rows.length - scroll;
  const visible = rows.slice(Math.max(0, end - room), end);

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
        <Text bold>feed</Text>
        <Text dimColor>{" · " + activeChannel}</Text>
        {scroll > 0 ? <Text color="yellow">{"  ↑" + scroll + " more · G/End to follow"}</Text> : null}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>(no messages yet — waiting for peer traffic)</Text>
      ) : (
        visible.map((r, i) =>
          r.kind === "head" ? (
            <HeadRow key={i} entry={r.entry} />
          ) : (
            <Text key={i} wrap="truncate-end">
              {"   " + r.text}
            </Text>
          ),
        )
      )}
    </Box>
  );
}
