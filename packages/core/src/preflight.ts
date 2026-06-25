import { mintCreds } from "./provision.js";
import { newIdentity } from "./identity.js";
import { probeConnect } from "./endpoint.js";
import { loadMeshes, removeMesh } from "./mesh-registry.js";
import type { MeshTarget } from "./mesh-target.js";

/**
 * Liveness verification for a resolved mesh target — the companion to {@link resolveMeshTarget}
 * ("which mesh") that answers "is it actually up, and does the registry still reflect reality".
 *
 * Lives in core (beside the registry, target resolution, and `probeConnect` it builds on) so every
 * surface shares ONE preflight rule instead of re-deriving it: the CLI's `connectOrExit` and the
 * manager's control commands both wrap these helpers. It owns the MECHANICS only — the classify
 * decision, the canonical message text, and the probe — never the I/O: colour and `process.exit`
 * stay at each call site, and pruning is the caller's explicit act, not a side effect of probing.
 */

/** The five distinct ways a preflight fails. Each also carries whether the target OWNS its registry
 *  entry (→ prune): `fromRegistry` means the server+mode came from a registry record (incl. a
 *  `local-recorded` project matched by root), so a definitive failure is a stale-entry signal. */
export type PreflightFailure =
  | "unreachable"
  | "registry-creds-rejected"
  | "registry-open-now-auth"
  | "creds-rejected"
  | "open-wants-auth";

/** Pure decision tree — separated from I/O so the whole branch tree is unit-testable (it's the
 *  riskiest logic: a wrong branch prunes a LIVE registry entry). Only a registry-OWNED source
 *  (`registry`/`current`/`flag-space`/`local-recorded`) is ever pruned. A non-registry source —
 *  `flag-server`/`local-space`, a raw `--creds` connection, or `flag-space-override` (a `--space`
 *  whose `--server` overrides the recorded broker) — is NEVER pruned: the probed endpoint is
 *  operator-supplied, so a failure there is the user's to diagnose, not a stale-registry signal. */
export function classifyPreflightFailure(
  source: MeshTarget["source"],
  reason: "auth-required" | "unreachable",
  hasAuth: boolean,
): { prune: boolean; kind: PreflightFailure } {
  // `flag-space-override` and `flag-server` are deliberately absent: the probe hit an operator-named
  // endpoint, not the registry-recorded broker, so its failure must not delete the recorded entry.
  const fromRegistry =
    source === "registry" ||
    source === "current" ||
    source === "flag-space" ||
    source === "local-recorded";
  if (reason === "unreachable") return { prune: fromRegistry, kind: "unreachable" };
  if (fromRegistry && hasAuth) return { prune: true, kind: "registry-creds-rejected" };
  if (fromRegistry) return { prune: true, kind: "registry-open-now-auth" };
  if (hasAuth) return { prune: false, kind: "creds-rejected" };
  return { prune: false, kind: "open-wants-auth" };
}

/** The canonical, surface-agnostic failure sentence for a classified preflight (plain text — the
 *  caller wraps it in colour and exits). `cotal up`/`cotal meshes` wording matches what
 *  `resolveMeshTarget` already throws, so the CLI and the manager speak with one voice. */
export function preflightMessage(kind: PreflightFailure, t: MeshTarget, pruned: boolean): string {
  switch (kind) {
    case "unreachable":
      return `✗ no mesh running at ${t.server}${pruned ? " (stale registry entry — removed)" : ""} — run \`cotal up\``;
    case "registry-creds-rejected":
      return `✗ mesh "${t.space}" at ${t.server} no longer matches its registry entry (credentials rejected — port reused?) — re-run \`cotal up\` from ${t.root}, or \`cotal meshes\` to see what's live`;
    case "registry-open-now-auth":
      return `✗ open mesh "${t.space}" at ${t.server} no longer matches its registry entry (broker now requires auth — port reused?) — re-run \`cotal up\` from ${t.root}, or \`cotal meshes\` to see what's live`;
    case "creds-rejected":
      return `✗ credentials for "${t.space}" were rejected at ${t.server} — a different mesh may be running there. Run \`cotal meshes\` to check, or \`cotal up\` here to start yours`;
    case "open-wants-auth":
      return `✗ broker at ${t.server} requires auth, but this mesh is open (no trust material) — use \`--space <name>\` for an auth mesh, or run \`cotal up\` here without \`--open\``;
  }
}

/** The plain failure sentence for a RAW (off-registry) reachability probe — the `--creds` /
 *  `--server`+unregistered-`--space` escape hatch, which never touches the registry (no prune, no
 *  stale-entry wording). */
export function reachableMessage(reason: "auth-required" | "unreachable", server: string): string {
  return reason === "auth-required"
    ? `✗ credentials rejected at ${server} — check your creds, or the broker wants different auth`
    : `✗ can't reach a broker at ${server} — is it running? (\`cotal up\`)`;
}

/** Probe a resolved target and, on failure, classify it — WITHOUT touching the registry. Returns the
 *  decision (incl. whether the caller SHOULD prune); the caller owns the `removeMesh` + message +
 *  exit. Probes with `probeCreds` when given (the caller's `--creds`/minted creds); otherwise mints
 *  a throwaway identity from the target's own trust material to test mere liveness. */
export async function preflightTarget(
  target: MeshTarget,
  probeCreds?: string,
): Promise<{ ok: true } | { ok: false; kind: PreflightFailure; prune: boolean }> {
  const creds =
    probeCreds ?? (target.auth ? await mintCreds(target.auth, newIdentity(), "manager") : undefined);
  const probe = await probeConnect(target.server, creds ? { creds } : {});
  if (probe.ok) return { ok: true };
  const { prune, kind } = classifyPreflightFailure(target.source, probe.reason, Boolean(target.auth));
  return { ok: false, kind, prune };
}

/**
 * Drop registry entries whose broker is gone — a `cotal up` that crashed or was `kill -9`'d without
 * `cotal down` leaves a record behind. Probe each in parallel; only `unreachable` (refused/timeout)
 * is stale, an auth broker answering `auth-required` is alive. An EXPLICIT call (never wired into
 * resolution itself), so registry mutation stays opt-in: callers that act on the registry
 * (`spawn`/`use`/`meshes`, the manager control commands) invoke it; `<TAB>` completion must not.
 */
export async function pruneStaleMeshes(): Promise<void> {
  await Promise.all(
    loadMeshes().map(async (m) => {
      const r = await probeConnect(m.server);
      if (!r.ok && r.reason === "unreachable") removeMesh(m.space);
    }),
  );
}
