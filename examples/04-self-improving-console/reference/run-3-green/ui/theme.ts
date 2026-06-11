import type { PresenceStatus } from "@cotal-ai/core";

// Per-agent color — a stable hash into a readable palette that avoids the status
// hues (green/yellow/red) so an agent's name never reads as a status. These are the
// hex equivalents of the xterm-256 indices the classic dashboard uses, so the Ink
// console and `cotal console` stay visually in sync.
const PALETTE = [
  "#00afff", "#ff8700", "#d75fd7", "#5fd787", "#ffaf00", "#87afff", "#ff5f5f",
  "#afd787", "#af87ff", "#d7af87", "#87d7ff", "#ffd787", "#5fafff", "#ff875f",
];
const colorCache = new Map<string, string>();

export function agentColor(name: string): string {
  let hex = colorCache.get(name);
  if (!hex) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    hex = PALETTE[h % PALETTE.length];
    colorCache.set(name, hex);
  }
  return hex;
}

// Status → glyph + Ink color, sorted by salience (working first).
export const STATUS: Record<PresenceStatus, { dot: string; color: string; word: string }> = {
  working: { dot: "●", color: "green", word: "working" },
  waiting: { dot: "◐", color: "yellow", word: "waiting" },
  idle: { dot: "○", color: "gray", word: "idle" },
  offline: { dot: "⨯", color: "gray", word: "offline" },
};

/** Compact "12s" / "5m" age from a millisecond delta. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/** Clock time for a feed timestamp. */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Border color for a panel — bright when focused, dim otherwise. */
export const focusBorder = (focused: boolean): string => (focused ? "cyan" : "gray");
