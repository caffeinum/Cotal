/**
 * Agent definition files — the persisted form of an agent's identity + persona.
 *
 *   .cotal/agents/<name>.md
 *   ---
 *   name: builder          # AgentCard-shaped identity in the frontmatter
 *   role: builder
 *   description: …
 *   tags: [edit, test]
 *   channels: [general]    # channels this agent subscribes to (read)
 *   publish: [general]     # channels this agent may post to (write); omit = same as channels
 *   model: opus            # optional CLI/model override
 *   face: sven             # optional avatar id for face-capable viewers
 *   ---
 *   <the Markdown body is the persona — an appended system prompt>
 *
 * A launcher resolves a name (or path) to one of these, hands the persona/model
 * to the agent process at spawn, and passes the file through so the joined
 * session reads its own card from it. Part of the wire contract's onboarding
 * half, alongside the join link.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EndpointKind } from "./types.js";

export interface AgentDef {
  name: string;
  role?: string;
  kind?: EndpointKind;
  description?: string;
  tags?: string[];
  channels?: string[];
  /** Channels this agent is allowed to publish to (auth mode → minted into pub-allow ACLs).
   *  Entries may be wildcard subtrees (`team.>`), symmetric with `channels`. Omitted means
   *  no explicit restriction beyond identity (the provisioner falls back to `channels`). */
  publish?: string[];
  /** Model override handed to the agent CLI (e.g. `claude --model`). */
  model?: string;
  /** Avatar id for face-capable viewers (e.g. the face-term animated terminal view). */
  face?: string;
  /** Markdown body — the agent's persona / appended system prompt. */
  persona?: string;
}

/** Strip wrapping quotes from a scalar value. */
function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    return v.slice(1, -1);
  return v;
}

/** Parse the frontmatter subset we support: `key: value` scalars and inline
 *  `key: [a, b]` string lists. Throws on anything fancier — block lists, nested
 *  maps and multi-doc YAML are deliberately unsupported (no silent fallback). */
function parseFrontmatter(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`agent file: unparseable frontmatter line "${raw}"`);
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (val.startsWith("[")) {
      if (!val.endsWith("]")) throw new Error(`agent file: unterminated list for "${key}"`);
      out[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}

/** Load and parse an agent definition file (Markdown + `---` frontmatter). */
export function loadAgentFile(path: string): AgentDef {
  const src = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`agent file ${path}: missing "---" frontmatter block`);
  const fm = parseFrontmatter(m[1]);
  const persona = m[2].trim();

  const str = (k: string): string | undefined => {
    const v = fm[k];
    if (Array.isArray(v)) throw new Error(`agent file ${path}: "${k}" must be a scalar`);
    return v;
  };
  const list = (k: string): string[] | undefined => {
    const v = fm[k];
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : [v];
  };

  const name = str("name");
  if (!name) throw new Error(`agent file ${path}: "name" is required`);
  const kind = str("kind");
  if (kind && kind !== "agent" && kind !== "endpoint")
    throw new Error(`agent file ${path}: "kind" must be "agent" or "endpoint"`);

  return {
    name,
    role: str("role"),
    kind: kind as EndpointKind | undefined,
    description: str("description"),
    tags: list("tags"),
    channels: list("channels"),
    publish: list("publish"),
    model: str("model"),
    face: str("face"),
    persona: persona || undefined,
  };
}

/** Write an agent definition back to disk in the form {@link loadAgentFile} reads:
 *  the set frontmatter fields followed by the persona body. Round-trips through the
 *  parser; creates parent dirs. The runtime persona-definition path uses this to
 *  persist a peer-defined agent as config. */
export function saveAgentFile(path: string, def: AgentDef): void {
  if (!def.name) throw new Error('saveAgentFile: "name" is required');
  const lines = ["---", `name: ${fmScalar(def.name)}`];
  if (def.role) lines.push(`role: ${fmScalar(def.role)}`);
  if (def.kind) lines.push(`kind: ${fmScalar(def.kind)}`);
  if (def.description) lines.push(`description: ${fmScalar(def.description)}`);
  if (def.tags?.length) lines.push(`tags: [${def.tags.map(fmItem).join(", ")}]`);
  if (def.channels?.length) lines.push(`channels: [${def.channels.map(fmItem).join(", ")}]`);
  if (def.publish?.length) lines.push(`publish: [${def.publish.map(fmItem).join(", ")}]`);
  if (def.model) lines.push(`model: ${fmScalar(def.model)}`);
  if (def.face) lines.push(`face: ${fmScalar(def.face)}`);
  lines.push("---");
  const body = def.persona ? `${def.persona.trim()}\n` : "";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n\n${body}`);
}

/** Render a frontmatter scalar so {@link loadAgentFile} reads it back unchanged. Quotes values
 *  the parser would otherwise misread (a leading `[`, a `,`/`:`/`#`, edge whitespace, or empty);
 *  throws on values the line-based format can't represent (a newline, or both quote styles). */
function fmScalar(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`saveAgentFile: value cannot contain a newline: ${JSON.stringify(value)}`);
  if (value !== "" && value === value.trim() && !/^[[]/.test(value) && !/[,:#"']/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error(`saveAgentFile: value cannot contain both quote styles: ${JSON.stringify(value)}`);
}

/** A list item additionally cannot hold a comma — the parser splits on `,` before unquoting. */
function fmItem(value: string): string {
  if (value.includes(",")) throw new Error(`saveAgentFile: list item cannot contain a comma: ${JSON.stringify(value)}`);
  return fmScalar(value);
}

/** Resolve a name-or-path to an agent file. A path (absolute, contains a slash,
 *  or ends in `.md`) is used as given; a bare name maps to the directory
 *  convention `<root>/.cotal/agents/<name>.md`. */
export function agentFilePath(root: string, nameOrPath: string): string {
  if (isAbsolute(nameOrPath)) return nameOrPath;
  if (nameOrPath.includes("/") || nameOrPath.endsWith(".md")) return resolve(root, nameOrPath);
  return join(root, ".cotal", "agents", `${nameOrPath}.md`);
}
