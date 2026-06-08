import { Fragment, useEffect, useRef, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import type { FeedEntry } from "../mesh.js";
import { agentColor, fmtTime, wrapText } from "./theme.js";

type Row =
  | { kind: "head"; entry: FeedEntry; entryIndex: number }
  | { kind: "body"; text: string };

function buildRows(entries: FeedEntry[], bodyWidth: number): { rows: Row[]; starts: number[] } {
  const rows: Row[] = [];
  const starts: number[] = [];
  entries.forEach((e, idx) => {
    starts.push(rows.length);
    rows.push({ kind: "head", entry: e, entryIndex: idx });
    for (const seg of wrapText(e.text, bodyWidth)) rows.push({ kind: "body", text: seg });
  });
  return { rows, starts };
}

/** Case-insensitive match across sender, target, and body — drives the `/` filter. */
function matches(e: FeedEntry, q: string): boolean {
  const hay = [
    e.from.name,
    e.from.role ?? "",
    e.channel ?? "",
    e.toService ?? "",
    ...(e.toNames ?? []),
    e.text,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
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

function HeadRow({ entry, selected }: { entry: FeedEntry; selected: boolean }) {
  const role = entry.from.role;
  return (
    <Text wrap="truncate-end" inverse={selected}>
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
 * The live message feed — main panel. Coalesced + windowed entries from useMesh, filtered to the
 * active channel (`all` = firehose incl. unicast/anycast) and the `/` query. A selection cursor
 * (↑/↓, follows the tail) highlights one entry; `Enter` opens its detail. Ink has no scroll view,
 * so we flatten entries to rows and slice a window that keeps the selected entry visible.
 */
export function Feed({
  entries,
  activeChannel,
  query,
  boxWidth,
  boxHeight,
  blocked,
  onFocus,
  onOpenDetail,
}: {
  entries: FeedEntry[];
  activeChannel: string;
  query: string;
  boxWidth: number;
  boxHeight: number;
  blocked: boolean;
  onFocus: (id: "roster" | "feed") => void;
  onOpenDetail: (entry: FeedEntry) => void;
}) {
  const { isFocused } = useFocus({ id: "feed" });
  useEffect(() => {
    if (isFocused) onFocus("feed");
  }, [isFocused, onFocus]);

  const q = query.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (activeChannel !== "all" && !(e.delivery === "multicast" && e.channel === activeChannel)) return false;
    return q ? matches(e, q) : true;
  });

  const room = Math.max(1, boxHeight - 3); // border (2) + title (1)
  const { rows, starts } = buildRows(filtered, Math.max(8, boxWidth - 4 - 3)); // pad/border (4) + indent (3)

  const [sel, setSel] = useState(0);
  const prevLen = useRef(0);
  // Follow the tail: if the cursor was on the last entry, ride new entries down.
  useEffect(() => {
    setSel((s) => {
      if (filtered.length === 0) return 0;
      if (prevLen.current === 0 || s >= prevLen.current - 1) return filtered.length - 1;
      return Math.min(s, filtered.length - 1);
    });
    prevLen.current = filtered.length;
  }, [filtered.length]);
  // Snap to the newest when the channel filter or query changes.
  useEffect(() => {
    setSel(filtered.length ? filtered.length - 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel, q]);

  const selClamped = Math.min(sel, Math.max(0, filtered.length - 1));

  useInput(
    (input, key) => {
      if (key.upArrow) setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSel((s) => Math.min(filtered.length - 1, s + 1));
      else if (key.pageUp) setSel((s) => Math.max(0, s - room));
      else if (key.pageDown) setSel((s) => Math.min(filtered.length - 1, s + room));
      else if (input === "g" || key.home) setSel(0);
      else if (input === "G" || key.end) setSel(filtered.length - 1);
      else if (key.return && filtered.length) onOpenDetail(filtered[selClamped]);
    },
    { isActive: isFocused && !blocked },
  );

  // Viewport: keep the selected entry visible, anchored to the tail by default.
  const selStart = starts[selClamped] ?? 0;
  const selEnd = starts[selClamped + 1] ?? rows.length;
  let end = rows.length;
  if (selStart < end - room) end = Math.min(rows.length, selStart + room);
  if (selEnd > end) end = Math.min(rows.length, selEnd);
  end = Math.max(room, Math.min(end, rows.length));
  const top = Math.max(0, end - room);
  const visible = rows.slice(top, end);
  const below = rows.length - end;

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
        {q ? <Text color="yellow">{"  /" + query}</Text> : null}
        {below > 0 ? <Text color="yellow">{"  ↓" + below + " more · G to follow"}</Text> : null}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>(no messages yet — waiting for peer traffic)</Text>
      ) : (
        visible.map((r, i) =>
          r.kind === "head" ? (
            <HeadRow key={top + i} entry={r.entry} selected={isFocused && r.entryIndex === selClamped} />
          ) : (
            <Text key={top + i} wrap="truncate-end">
              {"   " + r.text}
            </Text>
          ),
        )
      )}
    </Box>
  );
}
