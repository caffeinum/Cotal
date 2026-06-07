// Shared visual vocabulary for the Ink console. Colors here are Ink color values
// (hex or named) for <Text color=…>, not ANSI escapes — Ink owns the rendering.

import type { PresenceStatus } from "@cotal/core";

// Readable palette that avoids the status hues (green/yellow/red), so an agent's
// name never reads as a status. Mirrors render.ts's 256-color picks as hex.
const PALETTE = [
  "#5fafff", "#ff8700", "#5fd7af", "#87d75f", "#ffaf00", "#87afff",
  "#ff5f5f", "#afd787", "#af87ff", "#d7af87", "#5fd7ff", "#ffd75f",
];

const colorCache = new Map<string, string>();

/** Deterministic per-agent color (same hashing as render.ts) → an Ink hex. */
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

export interface StatusStyle {
  dot: string;
  word: string;
  color: string;
}

export const STATUS: Record<PresenceStatus, StatusStyle> = {
  working: { dot: "●", word: "working", color: "green" },
  waiting: { dot: "◐", word: "waiting", color: "yellow" },
  idle: { dot: "○", word: "idle", color: "gray" },
  offline: { dot: "⨯", word: "offline", color: "gray" },
};

/** "12s" / "4m" — compact age from an epoch-ms timestamp. */
export function ago(epochMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/** HH:MM:SS for a feed entry. */
export function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

/** Border color of a panel by focus state. */
export const focusBorder = (focused: boolean): string => (focused ? "cyan" : "gray");
