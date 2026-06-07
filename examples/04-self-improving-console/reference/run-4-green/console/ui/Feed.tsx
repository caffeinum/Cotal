import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, measureElement, type DOMElement } from "ink";
import { agentColor, clock, focusBorder } from "./theme.js";
import type { FeedEntry } from "./types.js";

/** The colored `→ target` chunk: #channel (multicast), @service (anycast), names (unicast). */
function Target({ e }: { e: FeedEntry }) {
  if (e.kind === "multicast") return <Text color="cyan">#{e.channel ?? "?"}</Text>;
  if (e.kind === "anycast") return <Text color="magenta">@{e.toService ?? "?"}</Text>;
  const names = e.to ?? [];
  return (
    <Text>
      {names.map((n, i) => (
        <Text key={i} color={agentColor(n)}>
          {(i > 0 ? ", " : "") + n}
        </Text>
      ))}
      {names.length > 1 ? <Text dimColor> ({names.length}×)</Text> : null}
    </Text>
  );
}

/** One message as a single truncated line: time · sender → target: body. */
function Line({ e }: { e: FeedEntry }) {
  const role = e.from.role && e.from.role !== e.from.name ? e.from.role : undefined;
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{clock(e.ts) + " "}</Text>
      <Text color={agentColor(e.from.name)} bold>
        {e.from.name}
      </Text>
      {role ? <Text dimColor>{"/" + role}</Text> : null}
      <Text dimColor> → </Text>
      <Target e={e} />
      <Text dimColor>: </Text>
      <Text>{e.text.replace(/\s+/g, " ")}</Text>
    </Text>
  );
}

/**
 * Live message feed. Auto-follows the tail; scrolling up (↑/PgUp) anchors to the
 * content as new lines arrive, exactly like the classic dashboard. Viewport height
 * is measured from the laid-out box so the window tracks terminal resizes.
 */
export function Feed({
  entries,
  focused,
  title,
}: {
  entries: FeedEntry[];
  focused: boolean;
  title: string;
}) {
  const ref = useRef<DOMElement | null>(null);
  const [rows, setRows] = useState(10);
  const [scroll, setScroll] = useState(0); // entries hidden below the viewport; 0 = follow tail
  const prevLen = useRef(entries.length);
  const prevTitle = useRef(title);

  // Measure the available rows after layout; converges in a frame, stable thereafter.
  useEffect(() => {
    if (ref.current) {
      const { height } = measureElement(ref.current);
      if (height > 0 && height !== rows) setRows(height);
    }
  });

  // Switching channels snaps to the tail; new entries while scrolled up stay anchored.
  useEffect(() => {
    if (prevTitle.current !== title) {
      prevTitle.current = title;
      prevLen.current = entries.length;
      setScroll(0);
      return;
    }
    const diff = entries.length - prevLen.current;
    prevLen.current = entries.length;
    if (diff !== 0) setScroll((s) => (s > 0 ? Math.max(0, s + diff) : 0));
  }, [title, entries.length]);

  const maxScroll = Math.max(0, entries.length - rows);
  const hidden = Math.min(scroll, maxScroll);
  const end = entries.length - hidden;
  const visible = entries.slice(Math.max(0, end - rows), end);

  useInput(
    (input, key) => {
      if (key.upArrow) setScroll((s) => Math.min(maxScroll, s + 1));
      else if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
      else if (key.pageUp) setScroll((s) => Math.min(maxScroll, s + rows));
      else if (key.pageDown) setScroll((s) => Math.max(0, s - rows));
      else if (input === "g" || key.home) setScroll(maxScroll);
      else if (input === "G" || key.end) setScroll(0);
    },
    { isActive: focused },
  );

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      borderStyle="round"
      borderColor={focusBorder(focused)}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold>{title}</Text>
        {hidden > 0 ? (
          <Text color="yellow">↑ {hidden} more · G to follow</Text>
        ) : (
          <Text dimColor>{entries.length} msgs</Text>
        )}
      </Box>
      <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" ref={ref}>
        {visible.length === 0 ? (
          <Text dimColor>(no messages yet — waiting for peer traffic)</Text>
        ) : (
          visible.map((e) => <Line key={e.id} e={e} />)
        )}
      </Box>
    </Box>
  );
}
