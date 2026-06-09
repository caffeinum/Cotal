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

/** Plain (no-color) target string for the selected row's uniform highlight. */
function targetText(e: FeedEntry): string {
  if (e.delivery === "multicast") return "#" + (e.channel ?? "?");
  if (e.delivery === "anycast") return "@" + (e.toService ?? "?");
  const names = (e.toNames ?? []).join(", ");
  return names + (e.count && e.count > 1 ? " (" + e.count + "×)" : "");
}

function HeadRow({ entry, selected }: { entry: FeedEntry; selected: boolean }) {
  const role = entry.from.role && entry.from.role !== entry.from.name ? "/" + entry.from.role : "";
  // Selected: one uniform cyan bar (like the tabs) — no per-segment colors to invert into a
  // multi-color mess. Unselected: the normal colored composition.
  if (selected) {
    return (
      <Text inverse bold color="cyan" wrap="truncate-end">
        {fmtTime(entry.ts) + " " + entry.from.name + role + " → " + targetText(entry) + ":"}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{fmtTime(entry.ts) + " "}</Text>
      <Text color={agentColor(entry.from.name)}>{entry.from.name}</Text>
      {role ? <Text dimColor>{role}</Text> : null}
      <Text dimColor> → </Text>
      <Target entry={entry} />
      <Text dimColor>:</Text>
    </Text>
  );
}

/**
 * The live message feed — main panel. Coalesced + windowed entries from useMesh, filtered to the
 * active channel (`all` = firehose incl. unicast/anycast) and the `/` query. Ink has no scroll view,
 * so we flatten entries to rows and scroll a row cursor line-by-line (follows the tail); the message
 * the cursor sits in is highlighted, and `Enter` opens its detail.
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
  onCompose,
  onReply,
}: {
  entries: FeedEntry[];
  activeChannel: string;
  query: string;
  boxWidth: number;
  boxHeight: number;
  blocked: boolean;
  onFocus: (id: "roster" | "feed") => void;
  onOpenDetail: (entry: FeedEntry) => void;
  onCompose?: () => void;
  onReply?: (entry: FeedEntry) => void;
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

  // The cursor is a ROW, not an entry — scrolling is line-granular. The "current message" (for the
  // highlight + Enter→detail) is whichever entry the cursor row falls in.
  const [cur, setCur] = useState(0);
  const prevRows = useRef(0);
  // Follow the tail: if the cursor was on the last row, ride new rows down.
  useEffect(() => {
    setCur((c) => {
      if (rows.length === 0) return 0;
      if (prevRows.current === 0 || c >= prevRows.current - 1) return rows.length - 1;
      return Math.min(c, rows.length - 1);
    });
    prevRows.current = rows.length;
  }, [rows.length]);
  // Jump to the newest when the channel filter or query changes.
  useEffect(() => {
    setCur(rows.length ? rows.length - 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel, q]);

  const curClamped = Math.min(cur, Math.max(0, rows.length - 1));
  // The entry whose row-range contains the cursor (largest start ≤ cur).
  let curEntry = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= curClamped) curEntry = i;
    else break;
  }

  useInput(
    (input, key) => {
      const half = Math.max(1, Math.floor(room / 2));
      const last = Math.max(0, rows.length - 1);
      if (key.upArrow || input === "k") setCur((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j") setCur((c) => Math.min(last, c + 1));
      else if (key.pageUp || (key.ctrl && input === "u"))
        setCur((c) => Math.max(0, c - (key.ctrl ? half : room)));
      else if (key.pageDown || (key.ctrl && input === "d"))
        setCur((c) => Math.min(last, c + (key.ctrl ? half : room)));
      else if (input === "g" || key.home) setCur(0);
      else if (input === "G" || key.end) setCur(last);
      else if (input === "c" && onCompose) onCompose();
      else if (input === "r" && onReply && filtered.length) onReply(filtered[curEntry]);
      else if (key.return && filtered.length) onOpenDetail(filtered[curEntry]);
    },
    { isActive: isFocused && !blocked },
  );

  // Viewport: a window of `room` rows that glides the cursor (centered, clamped to the ends).
  const maxTop = Math.max(0, rows.length - room);
  const top = Math.min(maxTop, Math.max(0, curClamped - Math.floor(room / 2)));
  const end = Math.min(rows.length, top + room);
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
            <HeadRow key={top + i} entry={r.entry} selected={isFocused && r.entryIndex === curEntry} />
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
