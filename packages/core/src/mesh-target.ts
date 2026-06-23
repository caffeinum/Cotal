import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE } from "./endpoint.js";
import { authDir, findCotalRoot, loadSpaceAuth, type SpaceAuth } from "./provision.js";
import {
  findMesh,
  getCurrent,
  homeCotalDir,
  loadMeshes,
  type MeshEntry,
} from "./mesh-registry.js";

/**
 * One coherent answer to "which mesh does this command act on, and where do its creds + personas
 * live" — resolved identically for both, so a spawn can never authenticate to mesh A while loading
 * mesh B's persona. Replaces the scattered `loadSpaceAuth(authDir(cotalRoot()))` + `resolveSpace` +
 * `DEFAULT_SERVER` guesswork that silently mistook `~/.cotal` for a space.
 *
 * Pure and offline (no network): `<TAB>` completion uses it as-is; `spawn` adds a reachability
 * preflight (`probeConnect`) on top.
 */
export interface MeshTarget {
  /** Absolute dir whose `.cotal/{auth,agents}` hold trust + personas. */
  root: string;
  server: string;
  space: string;
  /** Trust material, or undefined for an open mesh. */
  auth?: SpaceAuth;
  /** `<root>/.cotal/agents` — the persona catalog for this mesh. */
  personaRoot: string;
  source: "flag-server" | "flag-space" | "local-space" | "registry" | "current";
}

export interface ResolveFlags {
  /** `--server <url>` — raw broker escape hatch. */
  server?: string;
  /** `--space <name>` — pick a specific running mesh from the registry. */
  space?: string;
}

function personaRoot(root: string): string {
  return join(root, ".cotal", "agents");
}

function targetFromEntry(m: MeshEntry, server: string, source: MeshTarget["source"]): MeshTarget {
  return {
    root: m.root,
    server,
    space: m.space,
    auth: loadSpaceAuth(authDir(m.root)),
    personaRoot: personaRoot(m.root),
    source,
  };
}

function localTarget(root: string, server: string, source: MeshTarget["source"]): MeshTarget {
  const auth = loadSpaceAuth(authDir(root));
  return { root, server, space: auth?.space ?? DEFAULT_SPACE, auth, personaRoot: personaRoot(root), source };
}

/** A `.cotal/` that a user actually created here — not the machine-home dir the cwd walk-up lands on
 *  from outside any project (which has no space, just the daemon's pid/onboard files). */
function isGenuineSpace(root: string): boolean {
  return join(root, ".cotal") !== homeCotalDir() && existsSync(join(root, ".cotal"));
}

/**
 * Resolve the mesh target by precedence (first match wins):
 *  1. `--space` — registry lookup (errors if that space isn't running).
 *  2. `--server` — registry entry on that server (for creds/personas), else the local project.
 *  3. A genuine local project (`cwd` walks up to a real `.cotal/`) — local wins, like `git config`.
 *  4. The registry: 0 ⇒ error; 1 ⇒ use it; N ⇒ `current` if set, else error naming each + its root.
 * No silent fallback — an unresolved target throws one human sentence.
 */
export function resolveMeshTarget(cwd: string, flags: ResolveFlags = {}): MeshTarget {
  if (flags.space) {
    const m = findMesh(flags.space);
    if (!m) throw new Error(`no mesh named "${flags.space}" is running — see \`cotal meshes\``);
    return targetFromEntry(m, flags.server ?? m.server, "flag-space");
  }

  if (flags.server) {
    const m = loadMeshes().find((e) => e.server === flags.server);
    if (m) return targetFromEntry(m, flags.server, "flag-server");
    return localTarget(findCotalRoot(cwd), flags.server, "flag-server");
  }

  const root = findCotalRoot(cwd);
  if (isGenuineSpace(root)) return localTarget(root, DEFAULT_SERVER, "local-space");

  const meshes = loadMeshes();
  if (meshes.length === 0)
    throw new Error("no mesh running — run `cotal up` in a project, or pass `--server`");
  if (meshes.length === 1) return targetFromEntry(meshes[0], meshes[0].server, "registry");

  const current = getCurrent();
  const cur = current ? findMesh(current) : undefined;
  if (cur) return targetFromEntry(cur, cur.server, "current");

  const names = meshes.map((m) => `${m.space} (${m.root})`).join(", ");
  throw new Error(
    `multiple meshes running — ${names}. Pick one with \`--space <name>\` or set a default with \`cotal use <name>\`.`,
  );
}
