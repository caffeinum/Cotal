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
import { lstatSync, readFileSync, rmSync } from "node:fs";
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
import { findLedgerByHash, findLedgerByRun, hashManifestSource, ownedCredPath, writeLedger, type MeshLedger } from "../lib/manifest/ledger.js";

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
    for (const a of credPaths) console.log(`  ${c.red("-")} agent ${a.name} ${c.dim(`(id ${a.id.slice(0, 8)}, creds ${a.path}) — stopped only if name+id match live`)}`);
    for (const ch of ledger.created.channels) console.log(`  ${c.red("-")} channel ${c.cyan("#" + ch)} ${c.dim("(auth mesh: only if no members remain · open mesh: metadata cleanup, no membership audit)")}`);
    console.log(`  ${c.red("-")} run dir ${runDir ?? "(none)"} + ledger ${ledgerPath} ${c.dim("(only if every owned resource is removed/proven gone; else the ledger is kept)")}`);
    console.log(c.dim("\nDry run — nothing was changed. The live membership check + actual disposition happen at apply."));
    return;
  }

  // 4) Best-effort live teardown: stop owned agents (name AND id match) + remove childless owned
  //    channels. If the broker is down, nothing remote is torn down and the ledger is RETAINED.
  const stoppedIds = new Set<string>();
  const removed: string[] = [];
  const openNoFeed: string[] = []; // owned channels removed on an open mesh with no membership proof
  const skipped: Array<{ channel: string; why: string }> = [];
  const creds = await mintIfAuth(root, ledger.space);
  const reachable = await isReachable(ledger.server, creds ? { creds } : undefined);
  let liveById = new Map<string, { name: string; id: string }>();
  if (reachable) {
    const ep = await connectProbe({ space: ledger.space, server: ledger.server, creds });
    try {
      const ps = await ep.requestControl(CONTROL_ADMIN, { op: "ps" });
      const live = (ps.ok ? (ps.data as Array<{ name: string; id: string }>) : []) ?? [];
      liveById = new Map(live.map((r) => [r.id, r]));
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
        } else {
          openNoFeed.push(ch); // open mesh, no feed: removable (no isolation), but no membership proof
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
    console.log(c.yellow(`  ! ${ledger.server} unreachable — can't stop processes or remove channels; the ledger is RETAINED for a later \`down -f --run ${ledger.runId}\``));
  }

  // 5) Resolution: which owned resources are NOT proven handled. An agent is unresolved if the broker
  //    was unreachable, or it's still live under our recorded id and its stop failed (an id we don't
  //    see live is gone; a same-name/different-id agent is foreign, not ours). A channel is unresolved
  //    if it wasn't removed. The ledger is the ONLY durable ownership record, so we never erase it
  //    while owned resources may remain — we rewrite it down to the unresolved set instead
  //    (critic/security/engineer/ux PR2 blocker).
  const removedSet = new Set(removed);
  const unresolvedAgents = ledger.created.agents.filter((a) => !reachable || (liveById.has(a.id) && !stoppedIds.has(a.id)));
  const unresolvedChannels = ledger.created.channels.filter((ch) => !removedSet.has(ch));
  const unresolvedIds = new Set(unresolvedAgents.map((a) => a.id));
  const complete = unresolvedAgents.length === 0 && unresolvedChannels.length === 0;

  // 6) Local cleanup of RESOLVED resources only. A resolved (stopped/gone) agent's cred is deleted
  //    after verifying the cred file's own nkey id matches the recorded id (so a same-name foreign
  //    agent's cred, or a tampered-ledger cred path, is left alone; fail closed on unverifiable). An
  //    unresolved agent keeps its cred (still in use / to retry).
  for (const cp of credPaths) {
    if (unresolvedIds.has(cp.id)) continue;
    const sub = credSubject(cp.path);
    if (sub === undefined) continue; // no cred file
    if (sub === null) {
      console.error(c.yellow(`  ! ${cp.name} creds: unreadable/unverifiable — left in place`));
      continue;
    }
    if (sub !== cp.id) {
      console.error(c.yellow(`  ~ ${cp.name} creds belong to a different agent (id ${sub.slice(0, 8)} ≠ ${cp.id.slice(0, 8)}) — left in place`));
      continue;
    }
    try {
      if (unlinkFileNoFollow(cp.path)) console.log(c.dim(`  • removed creds for ${cp.name}`));
    } catch (e) {
      console.error(c.yellow(`  ! ${cp.name} creds: ${(e as Error).message}`));
    }
  }

  // 7) Summary + ledger disposition.
  for (const s of skipped) console.log(c.yellow(`  ~ left ${c.cyan("#" + s.channel)}: ${s.why}`) + c.dim(" (best-effort membership check — racy)"));
  if (openNoFeed.length)
    console.log(c.dim(`  note: removed ${openNoFeed.length} channel(s) on an OPEN mesh with no membership feed — no ACL isolation to protect, no membership proof: ${openNoFeed.map((n) => "#" + n).join(", ")}`));

  if (complete) {
    // Everything owned is removed/proven gone — safe to delete the run dir + launch spec + ledger.
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
    console.log(c.green(`✓ torn down run ${ledger.runId}`) + (removed.length ? c.dim(` — removed ${removed.length} channel(s): ${removed.map((n) => "#" + n).join(", ")}`) : ""));
  } else {
    // Partial: rewrite the ledger DOWN to the unresolved resources (atomic temp-then-rename) so a
    // later `down -f --run` can finish — never erase the only record while owned resources may remain.
    const remaining: MeshLedger = { ...ledger, created: { channels: unresolvedChannels, agents: unresolvedAgents } };
    writeLedger(root, remaining, { update: true });
    console.log(
      c.yellow(`! partial teardown of run ${ledger.runId}`) +
        c.dim(` — ${unresolvedAgents.length} agent(s) + ${unresolvedChannels.length} channel(s) still owned; ledger kept`),
    );
    console.log(c.dim(`  finish later (broker up / members gone): cotal down -f ${ledger.manifestPath} --run ${ledger.runId}`));
    process.exitCode = 1; // not a full success
  }
}

/** Extract the nkey subject (the agent id) from a NATS creds file's user JWT — to verify a cred file
 *  belongs to the recorded agent before `down -f` deletes it. Returns `undefined` if the file is
 *  absent, or `null` if it can't be verified (symlink / not a regular file / no JWT / unparseable) so
 *  the caller fails closed and leaves it. */
function credSubject(path: string): string | undefined | null {
  let raw: string;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return null;
  }
  const jwt = raw.split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3);
  if (!jwt) return null;
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Mint a manager (admin-control) cred for the ledger's space from the local trust material, or
 *  undefined for an open mesh / mismatched checkout (then we connect bare and do local cleanup). */
async function mintIfAuth(root: string, space: string): Promise<string | undefined> {
  const auth = loadSpaceAuth(authDir(root));
  if (!auth || auth.space !== space) return undefined;
  return mintCreds(auth, newIdentity(), "manager");
}
