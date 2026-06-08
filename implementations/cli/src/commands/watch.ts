import { console_ } from "./console.js";

/** `watch` — the passive line stream of a space's activity. An alias of `console --plain`
 *  (same observer, same MeshView model, no full-screen takeover) — handy for pipes/CI. */
export function watch(argv: string[]): Promise<void> {
  return console_([...argv, "--plain"]);
}
