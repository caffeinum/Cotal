/**
 * `cotal down -f cotal.yaml` — ownership-scoped teardown of a `spawn -f` deploy: stop + remove ONLY
 * the agents/channels that run created, never foreign actors on the shared mesh. The ledger is
 * treated as untrusted input and the WHOLE of it is validated + every path resolved up front, before
 * any destructive action (fail closed). Local-only: works from the same checkout/host that created
 * the run (the ledger is local state).
 *
 * Safety invariants (security/critic/UX early-PR2 review):
 *  - find the ledger by manifest hash; an edited file / >1 match FAILS with `--run`, never guesses;
 *  - stop an owned agent only when the live agent matches the recorded name AND nkey id — a name
 *    match with a different id is left alone (foreign reuse), never stopped by name;
 *  - cred paths are DERIVED from the auth root (never read from the ledger) and deleted no-follow;
 *  - a ledger-owned channel card is removed only when no members remain and membership is knowable —
 *    skipped (best-effort, racy) on ANY uncertainty, including an owned agent that failed to stop;
 *  - `--allow-stale` is apply-only and has no effect here.
 */
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONTROL_ADMIN,
  authDir,
  deleteChannels,
  isReachable,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  realDirNoSymlink,
  subjectMatches,
  unlinkFileNoFollow,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { connectProbe } from "../lib/manifest/live.js";
import { findLedgerByHash, findLedgerByRun, hashManifestSource, ownedCredPath, type MeshLedger } from "../lib/manifest/ledger.js";

export interface DownManifestFlags {
  run?: string;
  dryRun?: boolean;
}

export async function downManifest(file: string, flags: DownManifestFlags): Promise<void> {
  const abs = resolve(file);
  const root = cotalRoot();

  // 1) Resolve the ledger — fail, never guess (edited file / ambiguous → require --run).
  let ledgerPath: string;
  let ledger: MeshLedger;
  try {
    const found = flags.run ? findLedgerByRun(root, flags.run) : findLedgerByHash(root, hashManifestSource(readFileSync(abs, "utf8")));
    ledgerPath = found.path;
    ledger = found.ledger; // loadLedger already validated the WHOLE ledger as untrusted input
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }

  // 2) Show exactly what is being torn down BEFORE deleting anything.
  console.log(c.bold(`Tear down run ${ledger.runId}`));
  console.log(c.dim(`  ledger:   ${ledgerPath}`));
  console.log(c.dim(`  manifest: ${ledger.manifestPath} · hash ${ledger.manifestHash}`));
  console.log(c.dim(`  mesh:     ${ledger.space} @ ${ledger.server}`));
  console.log(c.dim(`  owns:     ${ledger.created.agents.length} agent(s), ${ledger.created.channels.length} channel(s)`));

  // 3) Resolve every owned path from validated IDs up front — a bad name fails the WHOLE teardown
  //    before any side effect (no partial "validated the one I'm deleting" flow).
  let credPaths: Array<{ requested: string; name: string; id: string; path: string }>;
  let runDir: string | null;
  let specPath: string;
  try {
    credPaths = ledger.created.agents.map((a) => ({ requested: a.requested, name: a.name, id: a.id, path: ownedCredPath(root, a.name) }));
    const runParent = realDirNoSymlink(root, ".cotal", "run"); // refuse a symlinked .cotal/run before deriving under it
    runDir = realDirNoSymlink(root, ".cotal", "run", ledger.runId);
    specPath = join(runParent ?? join(root, ".cotal", "run"), `${ledger.runId}.json`);
  } catch (e) {
    console.error(c.red(`✗ refusing teardown — unsafe owned resource: ${(e as Error).message}`));
    process.exit(1);
  }

  if (flags.dryRun) {
    console.log(c.bold("\nWould remove (dry run):"));
    for (const a of credPaths) console.log(`  ${c.red("-")} agent ${a.name} ${c.dim(`(id ${a.id.slice(0, 8)}, creds ${a.path})`)}`);
    for (const ch of ledger.created.channels) console.log(`  ${c.red("-")} channel ${c.cyan("#" + ch)} ${c.dim("(only if no members remain)")}`);
    console.log(`  ${c.red("-")} run dir ${runDir ?? "(none)"} + ledger ${ledgerPath}`);
    console.log(c.dim("\nDry run — nothing was changed."));
    return;
  }

  // 4) Best-effort live teardown: stop owned agents (name AND id match) + remove childless owned
  //    channels. The broker may be down — then we still do local cleanup and say what we couldn't reach.
  const stoppedIds = new Set<string>();
  const removed: string[] = [];
  const skipped: Array<{ channel: string; why: string }> = [];
  const creds = await mintIfAuth(root, ledger.space);
  const reachable = await isReachable(ledger.server, creds ? { creds } : undefined);
  if (reachable) {
    const ep = await connectProbe({ space: ledger.space, server: ledger.server, creds });
    try {
      const ps = await ep.requestControl(CONTROL_ADMIN, { op: "ps" });
      const live = (ps.ok ? (ps.data as Array<{ name: string; id: string }>) : []) ?? [];
      const liveById = new Map(live.map((r) => [r.id, r]));
      for (const a of ledger.created.agents) {
        const l = liveById.get(a.id);
        if (!l) {
          const sameName = live.find((r) => r.name === a.name);
          if (sameName) console.log(c.yellow(`  ~ ${a.name}: a different agent (id ${sameName.id.slice(0, 8)}) holds this name — NOT ours, left running`));
          else console.log(c.dim(`  • ${a.name}: not running`));
          continue;
        }
        const stop = await ep.requestControl(CONTROL_ADMIN, { op: "stop", args: { name: l.name } });
        if (stop.ok) {
          stoppedIds.add(a.id);
          console.log(c.green(`  ✓ stopped ${l.name}`));
        } else {
          console.log(c.yellow(`  ! ${l.name}: stop failed — ${stop.error ?? "unknown"}`));
        }
      }
      // Channel removal: skip on ANY uncertainty (best-effort, racy — said so in output). The
      // fail-closed "skip when membership is unobservable" rule protects ACL isolation, which exists
      // only on an AUTH mesh; an open mesh has no isolation and no membership feed by design, so an
      // owned card is removable there (otherwise `down -f` could never clean an open dev mesh).
      const openMesh = !creds;
      const stopFailed = ledger.created.agents.some((a) => liveById.has(a.id) && !stoppedIds.has(a.id));
      const snapshot = await ep.readMembership().catch(() => null);
      const ownedIds = new Set(ledger.created.agents.map((a) => a.id));
      const toRemove: string[] = [];
      for (const ch of ledger.created.channels) {
        if (stopFailed) {
          skipped.push({ channel: ch, why: "an owned agent failed to stop" });
          continue;
        }
        if (snapshot) {
          const others = snapshot.members.filter(
            (m) => !ownedIds.has(m.id) && (m.durable.includes(ch) || m.live.some((p) => subjectMatches(p, ch))),
          );
          if (others.length) {
            skipped.push({ channel: ch, why: `members present (${others.length})` });
            continue;
          }
        } else if (!openMesh) {
          skipped.push({ channel: ch, why: "membership unknown (no feed) on an auth mesh" });
          continue;
        }
        toRemove.push(ch);
      }
      if (toRemove.length) {
        await deleteChannels({ servers: ledger.server, space: ledger.space, creds, channels: toRemove });
        removed.push(...toRemove);
      }
    } finally {
      await ep.stop();
    }
  } else {
    console.log(c.yellow(`  ! ${ledger.server} unreachable — can't stop processes or remove channels; cleaning local artifacts only`));
    for (const ch of ledger.created.channels) skipped.push({ channel: ch, why: "broker unreachable" });
  }

  // 5) Local cleanup (always): owned cred files (no-follow), the run dir + launch spec, then the
  //    ledger LAST (after everything it described is handled).
  for (const cp of credPaths) {
    try {
      if (unlinkFileNoFollow(cp.path)) console.log(c.dim(`  • removed creds for ${cp.name}`));
    } catch (e) {
      console.error(c.yellow(`  ! ${cp.name} creds: ${(e as Error).message}`));
    }
  }
  try {
    unlinkFileNoFollow(specPath);
  } catch (e) {
    console.error(c.yellow(`  ! launch spec: ${(e as Error).message}`));
  }
  if (runDir) rmSync(runDir, { recursive: true, force: true });
  try {
    unlinkFileNoFollow(ledgerPath);
  } catch (e) {
    console.error(c.yellow(`  ! ledger: ${(e as Error).message}`));
  }

  // 6) Summary.
  for (const s of skipped) console.log(c.yellow(`  ~ left ${c.cyan("#" + s.channel)}: ${s.why}`) + c.dim(" (best-effort membership check — racy)"));
  console.log(c.green(`✓ torn down run ${ledger.runId}`) + (removed.length ? c.dim(` — removed ${removed.length} channel(s): ${removed.map((n) => "#" + n).join(", ")}`) : ""));
}

/** Mint a manager (admin-control) cred for the ledger's space from the local trust material, or
 *  undefined for an open mesh / mismatched checkout (then we connect bare and do local cleanup). */
async function mintIfAuth(root: string, space: string): Promise<string | undefined> {
  const auth = loadSpaceAuth(authDir(root));
  if (!auth || auth.space !== space) return undefined;
  return mintCreds(auth, newIdentity(), "manager");
}
