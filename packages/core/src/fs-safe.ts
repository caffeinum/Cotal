import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Create a directory chain under `parent`, one component at a time, **refusing to follow a
 * symlink**: an existing component that is a symlink (or a non-directory) is a hard error. A
 * pre-planted symlink parent would otherwise let an exclusive-create (`wx`) write land outside the
 * intended Cotal-owned tree — `wx` only guards the final path, not its parents, and a lexical
 * `dirname` check doesn't catch symlink traversal. Missing components are created `0700`.
 *
 * Narrow by design: it closes the pre-planted-symlink hole (the local single-user threat), not a
 * racing attacker (check→create isn't atomic). Returns the final directory path.
 */
export function ensureDirNoSymlink(parent: string, ...segments: string[]): string {
  let dir = parent;
  for (const seg of segments) {
    dir = join(dir, seg);
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        mkdirSync(dir, { mode: 0o700 });
        continue;
      }
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to write under "${dir}": it is a symlink`);
    if (!st.isDirectory()) throw new Error(`refusing to write under "${dir}": not a directory`);
  }
  return dir;
}
