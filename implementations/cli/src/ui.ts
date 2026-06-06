import type { PresenceStatus } from "@swarl/core";

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

/** 256-color foreground wrapper (xterm color index 0-255). */
export const color256 = (n: number) => (s: string) => `\x1b[38;5;${n}m${s}\x1b[0m`;

export function statusBadge(status: PresenceStatus): string {
  switch (status) {
    case "working":
      return c.green("● working");
    case "waiting":
      return c.yellow("◐ waiting");
    case "idle":
      return c.gray("○ idle");
    case "offline":
      return c.dim("⨯ offline");
  }
}
