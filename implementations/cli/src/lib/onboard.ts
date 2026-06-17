import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Machine-level "I've onboarded before" marker. Its presence flips `cotal` from the
 *  full first-run flow to the compact ensure+status run. Lives next to the materialized
 *  plugin marketplace under ~/.cotal. */
const MARKER = join(homedir(), ".cotal", "onboarded.json");

export function isOnboarded(): boolean {
  return existsSync(MARKER);
}

export function markOnboarded(version: string): void {
  mkdirSync(join(homedir(), ".cotal"), { recursive: true });
  writeFileSync(MARKER, JSON.stringify({ version, ts: new Date().toISOString() }, null, 2));
}
