import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAgentFile, type AgentDef } from "@cotal-ai/core";
import { cotalRoot } from "./paths.js";

/**
 * The persona catalog: the local `.cotal/agents/*.md` files an operator manages with
 * `cotal personas` and spawns by name. Filesystem-only and side-effect-free — it never
 * touches the mesh — so it is safe to call from a <TAB> completion as well as from `list`.
 * The single source of truth for "what personas exist", shared by both surfaces.
 */
export interface PersonaEntry {
  /** The filename stem (`.cotal/agents/<name>.md`), which is also the spawn name. */
  name: string;
  path: string;
  /** Parsed definition, or undefined when the file failed to parse (see `error`). */
  def?: AgentDef;
  /** Parse error message, if the file is malformed — surfaced rather than crashing the list. */
  error?: string;
}

/** The directory persona files live in: `<root>/.cotal/agents`. */
export function personasDir(root = cotalRoot()): string {
  return join(root, ".cotal", "agents");
}

/** List the persona files, each parsed (a malformed file becomes an entry with `error`, not a
 *  throw). Returns `[]` when the directory is absent. Filesystem-only — no mesh, no network. */
export function listPersonas(root = cotalRoot()): PersonaEntry[] {
  const dir = personasDir(root);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return []; // no .cotal/agents yet — an empty catalog, not an error
  }
  return files.sort().map((f) => {
    const name = f.slice(0, -3);
    const path = join(dir, f);
    try {
      return { name, path, def: loadAgentFile(path) };
    } catch (e) {
      return { name, path, error: (e as Error).message };
    }
  });
}

/** Just the persona names — the completion source for `cotal spawn` and `personas show/rm`. */
export function listPersonaNames(root = cotalRoot()): string[] {
  return listPersonas(root).map((p) => p.name);
}

/** Collect a deduped, sorted set of values declared across every persona file, via `pick`.
 *  Fail-closed: a single malformed file throws — the aggregate can't be trusted, so a derived
 *  completer must decline rather than offer a silently-partial set. The broken file is named loudly
 *  by `cotal personas list`, so the error stays visible; it's just not buried in a <TAB>. */
function declaredValues(root: string, pick: (def: AgentDef) => (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const e of listPersonas(root)) {
    if (e.error) throw new Error(`persona "${e.name}" is unparseable: ${e.error}`);
    for (const v of pick(e.def!)) if (v) out.add(v);
  }
  return [...out].sort();
}

/** Channels the persona files declare (`subscribe` ∪ `allowSubscribe` ∪ `allowPublish`), as the
 *  completion source for `cotal msg`/`send`. Wildcard ACL scopes (`team.>`, `*`) are excluded —
 *  they're read/post patterns, not concrete send targets. Authoritative-for-intent, not a claim the
 *  channel exists on the broker. Fail-closed via {@link declaredValues}. Filesystem-only — no mesh. */
export function listDeclaredChannels(root = cotalRoot()): string[] {
  return declaredValues(root, (d) => [
    ...(d.subscribe ?? []),
    ...(d.allowSubscribe ?? []),
    ...(d.allowPublish ?? []),
  ]).filter((ch) => !ch.includes(">") && !ch.includes("*"));
}

/** Roles the persona files declare (the `role:` field), as the completion source for
 *  `cotal ask`/`anycast`. Fail-closed via {@link declaredValues}. Filesystem-only — no mesh. */
export function listDeclaredRoles(root = cotalRoot()): string[] {
  return declaredValues(root, (d) => [d.role]);
}
