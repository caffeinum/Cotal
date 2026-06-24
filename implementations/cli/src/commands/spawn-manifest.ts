/**
 * `cotal spawn -f cotal.yaml` — deploy a mesh manifest onto a RUNNING mesh (additive). The only
 * command that touches a mesh it doesn't own, so it is creation-only + ownership-scoped:
 *
 *  - classifies channels (new → seed + own · existing → `exists-unmanaged`, card untouched) and
 *    agents (will-create · already-owned · stale) against the live mesh + any prior ledger;
 *  - boots agents through the workspace-local manager's admin `launch` op (it reads the run spec by
 *    id and mints from the resolved policy — the control wire carries no authority);
 *  - records exactly what it created in a `cotal-ledger/v1` ledger so `down -f` removes only that;
 *  - flags unmanaged actors on declared channels as a SECURITY warning (an explicit lower bound).
 *
 * `--dry-run` prints the plan and mutates nothing; a stale declared agent exits non-zero unless
 * `--allow-stale <names>`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_SERVER,
  readChannelRegistry,
  seedChannelRegistry,
  type ControlReply,
  type MembershipSnapshot,
  type Presence,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { connectOrExit } from "../lib/connect.js";
import { managerUp, startManagerDetached } from "../lib/manager-proc.js";
import { loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { buildLaunchSpec, channelsSeed, genRunId, preflightConnectors, writeLaunchSpec } from "../lib/manifest/apply.js";
import { buildLedger, hashManifestSource, listLedgers, writeLedger, type LedgerAgent } from "../lib/manifest/ledger.js";
import { classifyAgents, classifyChannels, detectUnmanagedActors } from "../lib/manifest/spawn-plan.js";
import { connectProbe, launchAgent, settleRoster, waitManagerReady } from "../lib/manifest/live.js";
import { renderInherited, renderSpawnPlan, renderSpawnSummary, renderWarnings } from "../lib/manifest/render.js";
import { failManifest } from "./topology.js";

export interface SpawnManifestFlags {
  dryRun: boolean;
  server?: string;
  space?: string;
  runtime?: string;
  /** Narrow, named waiver of the stale-agent gate (apply-only; never suppresses security warnings). */
  allowStale?: string[];
}

const RUNTIMES = ["pty", "tmux", "cmux"];

export async function spawnManifest(file: string, flags: SpawnManifestFlags): Promise<void> {
  const abs = resolve(file);
  let prepared: PreparedManifest;
  try {
    prepared = loadManifest(abs);
  } catch (e) {
    failManifest(e);
  }
  if (flags.runtime && !RUNTIMES.includes(flags.runtime)) {
    console.error(c.red(`✗ unknown --runtime "${flags.runtime}" — expected ${RUNTIMES.join(", ")}`));
    process.exit(1);
  }
  const eff = applyOverrides(prepared, flags);
  const m = eff.manifest;
  const space = m.space;
  const runtime = m.runtime ?? "pty";

  // Connectors + their binaries must exist before any mutation (no fallback).
  const connErr = preflightConnectors(eff);
  if (connErr) {
    console.error(c.red(`✗ connector preflight failed: ${connErr}`));
    process.exit(1);
  }

  // spawn -f deploys onto a RUNNING mesh — the broker MUST be reachable (opposite of up -f). Resolve
  // the mesh + mint a manager (admin-control) cred from the local registry/auth (same-checkout).
  const connection = await connectOrExit({ server: m.broker?.servers ?? flags.server, space }, "manager");

  const root = cotalRoot();
  const manifestHash = hashManifestSource(readFileSync(abs, "utf8"));

  // A prior ledger for this manifest content ⇒ a re-apply (reuse its runId, classify against it).
  const priors = listLedgers(root).filter((l) => l.ledger.manifestHash === manifestHash && l.ledger.space === space);
  if (priors.length > 1) {
    console.error(c.red(`✗ ${priors.length} runs already deployed this manifest (${priors.map((p) => p.ledger.runId).join(", ")}) — tear one down first: \`cotal down -f ${file} --run <id>\``));
    process.exit(1);
  }
  const prior = priors[0]?.ledger;
  const runId = prior?.runId ?? genRunId();
  const ownedKeys = new Set(prior?.created.channels ?? []);
  const ownedIds = new Set((prior?.created.agents ?? []).map((a) => a.id));
  const ownedNames = new Set((prior?.created.agents ?? []).map((a) => a.name));

  const liveRegistry = await readChannelRegistry({ servers: connection.server, space, creds: connection.creds });
  const ep = await connectProbe({ space, server: connection.server, creds: connection.creds });
  try {
    const roster: Presence[] = await settleRoster(ep);
    const membership: MembershipSnapshot | null = await ep.readMembership().catch(() => null);

    const channelPlan = classifyChannels(m.channels, liveRegistry, ownedKeys);
    const agentPlan = classifyAgents(eff.agents, roster, prior);
    const unmanaged = detectUnmanagedActors(
      m.channels.map((ch) => ch.name),
      membership,
      roster,
      { ids: ownedIds, names: ownedNames },
    );

    if (flags.dryRun) {
      console.log(renderSpawnPlan(eff, channelPlan, agentPlan, unmanaged, { server: connection.server, runId, dryRun: true }));
      return;
    }

    // Stale gate (apply-only): a re-declared owned agent whose resolved policy changed must restart —
    // never silently keep running the old policy. Exit non-zero unless explicitly waived by name.
    const allow = new Set(flags.allowStale ?? []);
    const unwaived = agentPlan.stale.filter((e) => !allow.has(e.agent.name));
    if (unwaived.length) {
      console.error(c.red(`✗ ${unwaived.length} declared agent(s) are stale (policy changed) — restart required:`));
      for (const e of unwaived) console.error(c.red(`    ${e.agent.name}: ${e.prior?.name} hash ${e.prior?.hash.slice(0, 8)} → ${e.hash.slice(0, 8)}`));
      console.error(c.dim(`  Waive (they keep running the OLD policy until restarted): --allow-stale ${unwaived.map((e) => e.agent.name).join(",")}`));
      process.exit(1);
    }

    console.log(renderSpawnPlan(eff, channelPlan, agentPlan, unmanaged, { server: connection.server, runId, dryRun: false }), "\n");

    // 1) Seed ONLY brand-new channel keys — no defaults, no pre-existing/unmanaged card mutation.
    if (channelPlan.create.length)
      await seedChannelRegistry({ servers: connection.server, space, creds: connection.creds, file: channelsSeed(channelPlan.create) });

    // 2-4) Boot the will-create agents through the workspace-local manager's admin `launch` op,
    //      capturing the SPAWNED name + id the ledger keys on (creds are filed under the
    //      collision-numbered spawned name, not the manifest key). Skipped entirely for a
    //      channels-only deploy — no need to stand up a manager.
    const agents: LedgerAgent[] = [...(prior?.created.agents ?? [])];
    const launchedNow: string[] = [];
    if (agentPlan.willCreate.length) {
      // The manager reads the run spec by runId on each `launch`.
      writeLaunchSpec(root, buildLaunchSpec(eff, runId), { update: Boolean(prior) });
      if (!managerUp()) startManagerDetached({ space, server: connection.server, runtime });
      if (!(await waitManagerReady(ep))) {
        console.error(c.red("✗ manager did not become ready for control — see .cotal/manager.log"));
        process.exit(1);
      }
      for (const e of agentPlan.willCreate) {
        const reply: ControlReply = await launchAgent(ep, runId, e.agent.name);
        if (!reply.ok) {
          console.error(c.red(`✗ ${e.agent.name}: ${reply.error ?? "launch failed"}`));
          continue;
        }
        const d = reply.data as { name: string; id: string; requested: string; hash: string };
        agents.push({ requested: d.requested, name: d.name, id: d.id, hash: d.hash });
        launchedNow.push(d.name);
        console.log(c.green(`✓ launched ${d.name}`) + c.dim(` (${e.agent.agentType})`));
      }
    }

    // 5) Write/update the creation-only ownership ledger (prior owned ∪ this run's new).
    const createdChannels = dedupe([...(prior?.created.channels ?? []), ...channelPlan.create.map((ch) => ch.name)]);
    const ledger = buildLedger({ runId, space, server: connection.server, manifestHash, manifestPath: abs, channels: createdChannels, agents: dedupeAgents(agents) });
    const ledgerPath = writeLedger(root, ledger, { update: Boolean(prior) });

    // 6) Summary + the exact ownership-scoped teardown command.
    console.log("\n" + renderSpawnSummary({
      space,
      server: connection.server,
      runId,
      ledgerPath,
      manifestPath: abs,
      created: channelPlan.create.map((ch) => ch.name),
      launched: launchedNow,
      existsUnmanaged: channelPlan.existsUnmanaged.map((x) => x.channel.name),
      unmanaged,
    }));
    const inh = renderInherited(eff);
    if (inh) console.log("\n" + inh);
    if (eff.warnings.length) console.log("\n" + renderWarnings(eff.warnings));
  } finally {
    await ep.stop();
  }
}

/** CLI overrides for `spawn -f` (flag > manifest > default): the connect target + runtime. No
 *  host/open — we connect to an existing broker, not bind one. */
function applyOverrides(prepared: PreparedManifest, o: SpawnManifestFlags): PreparedManifest {
  const m = prepared.manifest;
  const broker = { ...m.broker };
  if (o.server) broker.servers = o.server;
  if (!broker.servers) broker.servers = DEFAULT_SERVER;
  return {
    ...prepared,
    manifest: {
      ...m,
      broker,
      space: o.space ?? m.space,
      runtime: (o.runtime as typeof m.runtime) ?? m.runtime,
    },
  };
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/** Keep one entry per nkey id (defensive — `willCreate` excludes prior-owned, so no dup in practice). */
function dedupeAgents(agents: LedgerAgent[]): LedgerAgent[] {
  const byId = new Map<string, LedgerAgent>();
  for (const a of agents) byId.set(a.id, a);
  return [...byId.values()];
}
