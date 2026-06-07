import type { FeedEntry } from "../mesh.js";

/**
 * One terminal row of the feed. A `head` row carries the whole entry (rendered as
 * `time sender → target:`); a `body` row is a single pre-wrapped text segment.
 * Pre-wrapping to exact rows lets us window the feed by line count — same approach
 * as the classic dashboard, so auto-scroll and scroll-up stay precise.
 */
export type FeedLine =
  | { type: "head"; entry: FeedEntry }
  | { type: "body"; text: string };

const INDENT = "  ";

/** Greedy word-wrap to `width` columns; a word wider than `width` gets its own row. */
function wrap(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const out: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    if (cur.length === 0) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += " " + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  out.push(cur);
  return out;
}

/** Expand feed entries into exact terminal rows (header + indented, wrapped body). */
export function flatten(entries: FeedEntry[], innerWidth: number): FeedLine[] {
  const bodyWidth = Math.max(8, innerWidth - INDENT.length);
  const out: FeedLine[] = [];
  for (const e of entries) {
    out.push({ type: "head", entry: e });
    for (const raw of e.text.split(/\r?\n/))
      for (const seg of wrap(raw, bodyWidth)) out.push({ type: "body", text: INDENT + seg });
  }
  return out;
}

/**
 * Slice the feed to a viewport. `scroll` = rows above the tail (0 = follow newest).
 * Returns the visible rows plus the clamped scroll and maxScroll so the caller can
 * keep its scroll state honest and show a "more above" hint.
 */
export function windowFeed(
  entries: FeedEntry[],
  innerWidth: number,
  room: number,
  scroll: number,
): { visible: FeedLine[]; scroll: number; maxScroll: number } {
  const lines = flatten(entries, innerWidth);
  const maxScroll = Math.max(0, lines.length - room);
  const clamped = Math.max(0, Math.min(scroll, maxScroll));
  const end = lines.length - clamped;
  return { visible: lines.slice(Math.max(0, end - room), end), scroll: clamped, maxScroll };
}
