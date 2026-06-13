import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface SetupLog {
  path: string;
  line(s: string): void;
}

/** Timestamped append log for `cotal setup` — one file, also the first thing a
 *  Claude handoff is pointed at. */
export function openSetupLog(cwd: string): SetupLog {
  const path = resolve(cwd, ".cotal/setup.log");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `\n=== cotal setup — ${new Date().toISOString()} ===\n`);
  return {
    path,
    line(s: string) {
      appendFileSync(path, `${new Date().toISOString()} ${s}\n`);
    },
  };
}
