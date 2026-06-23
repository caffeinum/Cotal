import {
  findMesh,
  getCurrent,
  mintCreds,
  newIdentity,
  probeConnect,
  removeMesh,
  resolveMeshTarget,
  type MeshTarget,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { pruneStaleMeshes } from "./meshes.js";

/**
 * The one way every command that touches a running mesh figures out WHICH mesh + with what creds,
 * and confirms it's actually up — so `spawn`, `send`, `console`, `join`, `web`, `channels`, and
 * `history` all behave identically from any directory instead of each re-deriving it from a cwd
 * walk-up (which mistook `$HOME/.cotal` for a space and crashed with a raw NATS auth violation).
 */

/** Resolve the mesh a command targets, exiting with one human sentence on an unresolved/ambiguous
 *  registry rather than a stack trace. Prunes dead registry entries first so a crashed mesh doesn't
 *  block a bare command or get offered by `--space`. */
export async function resolveTargetOrExit(flags: {
  server?: string;
  space?: string;
}): Promise<MeshTarget> {
  await pruneStaleMeshes();
  let target: MeshTarget;
  try {
    target = resolveMeshTarget(process.cwd(), flags);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  // If a dangling `current` was silently bypassed — it named a mesh that's since gone and we fell
  // back to the only live one — say so. The N>1 case errors loudly; this is the one spot that would
  // otherwise quietly redirect a stale default.
  const cur = getCurrent();
  if (cur && !findMesh(cur) && target.source === "registry")
    console.error(c.dim(`note: default mesh "${cur}" is down — using "${target.space}"`));
  return target;
}

/** Confirm the resolved mesh is up and accepts these creds — replaces the raw NATS "Authorization
 *  Violation" trace with one sentence, and prunes the entry if the broker is gone. Probes with
 *  `probeCreds` when given (the caller's `--creds`/minted creds); otherwise mints a throwaway
 *  identity from the target's own trust material. */
export async function preflightOrExit(target: MeshTarget, probeCreds?: string): Promise<void> {
  const creds =
    probeCreds ?? (target.auth ? await mintCreds(target.auth, newIdentity(), "manager") : undefined);
  const probe = await probeConnect(target.server, creds ? { creds } : {});
  if (probe.ok) return;
  // A target whose server + mode came from a registry record owns that record, so a definitive
  // failure prunes the stale entry. `local-recorded` (a local project matched to an entry by root)
  // is registry-owned for pruning even though the success line treats it as a quiet local target.
  const fromRegistry =
    target.source === "registry" ||
    target.source === "current" ||
    target.source === "flag-space" ||
    target.source === "local-recorded";
  if (probe.reason === "unreachable") {
    if (fromRegistry) removeMesh(target.space); // the broker is gone — drop the stale entry
    console.error(
      c.red(
        `✗ no mesh running at ${target.server}${fromRegistry ? " (stale registry entry — removed)" : ""} — run \`cotal up\``,
      ),
    );
  } else if (fromRegistry && target.auth) {
    // Creds minted from the registry's own trust material were rejected — the entry now points at a
    // DIFFERENT broker on that port. Not "spawn from the root" (we just used it); the entry is stale.
    removeMesh(target.space);
    console.error(
      c.red(
        `✗ mesh "${target.space}" at ${target.server} no longer matches its registry entry (credentials rejected — port reused?) — re-run \`cotal up\` from ${target.root}, or \`cotal meshes\` to see what's live`,
      ),
    );
  } else if (fromRegistry) {
    // An OPEN-mode registry target probed credlessly, but the broker now wants auth — the recorded
    // open mesh is gone (port reused by an auth broker). Same stale class; drop the entry.
    removeMesh(target.space);
    console.error(
      c.red(
        `✗ open mesh "${target.space}" at ${target.server} no longer matches its registry entry (broker now requires auth — port reused?) — re-run \`cotal up\` from ${target.root}, or \`cotal meshes\` to see what's live`,
      ),
    );
  } else if (target.auth) {
    // Creds were presented and rejected, but the target is a local project / --server we don't own
    // in the registry. A different mesh is likely on that port — the user owns the diagnosis.
    console.error(
      c.red(
        `✗ credentials for "${target.space}" were rejected at ${target.server} — a different mesh may be running there. Run \`cotal meshes\` to check, or \`cotal up\` here to start yours`,
      ),
    );
  } else {
    // No creds to present (open, non-registry) and the broker wants auth.
    console.error(
      c.red(
        `✗ broker at ${target.server} requires auth, but this mesh is open (no trust material) — use \`--space <name>\` for an auth mesh, or run \`cotal up\` here without \`--open\``,
      ),
    );
  }
  process.exit(1);
}
