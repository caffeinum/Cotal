import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assertValidName, type MeshLaunchAgent, type MeshLaunchSpec } from "@cotal-ai/core";

/**
 * Load + materialize a resolved launch spec for `supervise --launch`.
 *
 * The CLI's manifest resolver produces the spec (`cotal-launch/v1`); the manager treats it as
 * **untrusted input** — strict schema, path-safe run id + agent names — then materializes each
 * agent's persona to a **transient, non-authoritative** file under `.cotal/run/<runId>/agents/`
 * (never `.cotal/agents/`, never persona-discoverable). Creds are minted from the spec's `policy`,
 * not from this file, so the file carries no ACL/capability frontmatter.
 */

// Path-safe (no `/`, `..`, whitespace) — it names a directory under `.cotal/run`.
const RunId = z.string().regex(/^[A-Za-z0-9_-]+$/, "runId must be a path-safe token ([A-Za-z0-9_-])");

const LaunchAgentSchema = z.strictObject({
  name: z.string().min(1),
  agent: z.string().min(1),
  role: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  subscribe: z.array(z.string()),
  allowSubscribe: z.array(z.string()),
  allowPublish: z.array(z.string()),
  personaPath: z.string().optional(),
  hash: z.string(),
});

const LaunchSpecSchema = z.strictObject({
  apiVersion: z.literal("cotal-launch/v1"),
  space: z.string().min(1),
  runId: RunId,
  agents: z.array(LaunchAgentSchema),
});

/** Parse + strictly validate a launch spec file. Throws on any deviation (it's untrusted, local
 *  though it is) — including an agent name that isn't a safe mesh/file token (no path traversal). */
export function loadLaunchSpec(path: string): MeshLaunchSpec {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`launch spec ${path}: ${(e as Error).message}`);
  }
  const r = LaunchSpecSchema.safeParse(json);
  if (!r.success)
    throw new Error(`launch spec ${path}: ${r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
  for (const a of r.data.agents) assertValidName(a.name); // names the transient file → must be safe
  return r.data;
}

/** The workspace-local run directory for a launch run — NOT `.cotal/agents` (never discovered as a
 *  reusable persona). Deleted by `cotal down`. */
export function runDir(root: string, runId: string): string {
  return join(root, ".cotal", "run", runId);
}

/** Materialize one resolved agent's persona to a transient file the connector reads, and return its
 *  path. Carries only what a connector needs (identity/role/model/description + body) plus a loud
 *  generated-artifact header — never ACL/capability frontmatter (creds come from the spec's policy). */
export function materializePersona(root: string, runId: string, a: MeshLaunchAgent): string {
  const dir = join(runDir(root, runId), "agents");
  mkdirSync(dir, { recursive: true });
  const fm = ["---", `name: ${a.name}`];
  if (a.role) fm.push(`role: ${scalar(a.role)}`);
  if (a.model) fm.push(`model: ${scalar(a.model)}`);
  if (a.description) fm.push(`description: ${scalar(a.description)}`);
  fm.push("---", "");
  const src = a.personaPath ?? "the manifest";
  const header = `<!-- Generated runtime artifact from a cotal mesh manifest (run ${runId}). Do NOT edit — regenerated on each launch and deleted by \`cotal down\`. Edit ${src} instead. This file is not a reusable persona and carries no access authority. -->`;
  const body = a.body ? `${a.body.trim()}\n` : "";
  const path = join(dir, `${a.name}.md`);
  writeFileSync(path, `${fm.join("\n")}${header}\n\n${body}`, { mode: 0o600 });
  return path;
}

/** Build the manager spawn opts for a launch agent: identity/role/model + the resolved object
 *  (which carries the ACL authority) + the materialized configPath. */
export function launchAgentToStartOpts(a: MeshLaunchAgent, configPath: string): {
  name: string;
  agent: string;
  role?: string;
  model?: string;
  config: string;
  resolved: MeshLaunchAgent;
} {
  return { name: a.name, agent: a.agent, role: a.role, model: a.model, config: configPath, resolved: a };
}

/** Quote a frontmatter scalar so the agent-file parser reads it back unchanged (it strips a matching
 *  outer quote pair). Plain tokens pass through; anything with structural chars is double-quoted. */
function scalar(v: string): string {
  if (v === v.trim() && !/^\[/.test(v) && !/[:#"'\r\n]/.test(v)) return v;
  if (!v.includes('"') && !/[\r\n]/.test(v)) return `"${v}"`;
  return JSON.stringify(v.replace(/[\r\n]+/g, " "));
}
