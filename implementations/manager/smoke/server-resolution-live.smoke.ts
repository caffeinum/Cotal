/**
 * LIVE-broker e2e for the manager control commands' target resolution (`resolveManagerTarget`, used
 * by `ps`/`start`/`stop`/`attach`). Proves they resolve their broker from the mesh registry — the
 * same way the rest of the CLI does — instead of silently assuming `DEFAULT_SERVER` (:4222), the
 * original bug: `ps --space <mesh>` for a mesh on another port hit :4222 and got an auth violation.
 *
 * This is the LIVE counterpart to the now-core preflight unit smoke: since `resolveManagerTarget`
 * now PREFLIGHTS (probe + stale-prune, shared with `connectOrExit`), its success paths can only be
 * exercised against REAL brokers — a registered mesh on a dead port would (correctly) be pruned. So
 * the pure decision tree lives in `smoke:preflight` (broker-free); the resolve+preflight wiring is
 * proven here. Spins isolated nats-server processes (COTAL_HOME sandboxed); kills ONLY its own PIDs,
 * never pkill, so a co-running broker on :4222 is untouched. Needs `nats-server` on PATH.
 * Run: pnpm smoke:server-resolution:live
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the registry BEFORE importing core — homeCotalDir() reads COTAL_HOME per call.
const home = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-home-"));
const cwd = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-cwd-"));
const projectRoot = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-root-"));
process.env.COTAL_HOME = home;
process.chdir(cwd); // a dir with no `.cotal` up-tree, so bare resolution falls through to the registry

const { recordMesh, loadMeshes, probeConnect, DEFAULT_SERVER } = await import("@cotal-ai/core");
const { resolveManagerTarget } = await import("../src/commands.js");

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function startBroker(port: number): ChildProcess {
  const cp = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
  kids.push(cp);
  return cp;
}
async function waitReady(server: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await probeConnect(server, { timeoutMs: 400 })).ok) return;
    await sleep(100);
  }
  throw new Error(`broker ${server} never came up`);
}

const OTHER = "nats://127.0.0.1:14999"; // the recorded mesh's broker (non-default port)
const OVERRIDE = "nats://127.0.0.1:7777"; // a second live broker for --server override / raw-open
const ts = new Date(0).toISOString();

try {
  // Two live OPEN brokers (open ⇒ no creds to mint — keeps the smoke free of a creds-issuing broker).
  startBroker(14999);
  startBroker(7777);
  await waitReady(OTHER);
  await waitReady(OVERRIDE);
  recordMesh({ space: "team-alpha", server: OTHER, root: projectRoot, mode: "open", ts });

  // 1. The fix: `--space` resolves the registry-recorded broker (and PREFLIGHTS it live), NOT :4222.
  const bySpace = await resolveManagerTarget({ space: "team-alpha" });
  ok("--space resolves the registry-recorded broker", bySpace.server === OTHER, bySpace.server);
  ok("did NOT fall back to DEFAULT_SERVER (:4222)", bySpace.server !== DEFAULT_SERVER, bySpace.server);
  ok("open mesh ⇒ no creds minted", bySpace.creds === undefined, bySpace.creds);
  ok("resolved space is preserved", bySpace.space === "team-alpha", bySpace.space);
  // The new preflight must NOT prune a LIVE registered entry — the load-bearing safety property.
  ok("live registered entry survives the preflight prune sweep", loadMeshes().some((m) => m.space === "team-alpha"), loadMeshes());

  // 2. Bare (no flags) with a single registered mesh → still that mesh's broker.
  ok("bare resolves the single registered mesh", (await resolveManagerTarget({})).server === OTHER);

  // 3. `--server` stays an explicit override (preflighted against the override broker).
  ok("--server overrides the registry", (await resolveManagerTarget({ space: "team-alpha", server: OVERRIDE })).server === OVERRIDE);

  // 4. Raw OPEN off-registry escape hatch (parity with connectOrExit): `--server` + an UNregistered
  //    `--space` → a bare connection, no registry lookup, no creds (reachability-checked live).
  const rawOpen = await resolveManagerTarget({ server: OVERRIDE, space: "not-registered" });
  ok(
    "--server + unregistered --space → raw open (no creds, no registry)",
    rawOpen.server === OVERRIDE && rawOpen.space === "not-registered" && rawOpen.creds === undefined,
    rawOpen,
  );

  // 5. prune-on-death wired through the manager's resolve path: kill the recorded broker, then the
  //    shared stale-prune (which `resolveManagerTarget` now runs before resolving) drops the entry.
  kids[0]!.kill("SIGTERM");
  for (let i = 0; i < 50 && kids[0]!.exitCode === null && kids[0]!.signalCode === null; i++) await sleep(100);
  const dead = await probeConnect(OTHER, { timeoutMs: 800 });
  ok("killed broker → unreachable", !dead.ok && dead.reason === "unreachable", dead);
  // A second registered mesh stays live so the bare resolver doesn't error after the dead one prunes;
  // resolveManagerTarget({space:team-alpha}) would now exit(1) (correct), so drive the prune via the
  // override broker as the survivor and assert the dead entry is gone.
  recordMesh({ space: "survivor", server: OVERRIDE, root: projectRoot, mode: "open", ts });
  await resolveManagerTarget({ space: "survivor" }); // its preflight runs the prune sweep
  ok("dead recorded entry is pruned through the manager resolve path", !loadMeshes().some((m) => m.space === "team-alpha"), loadMeshes());

  console.log(`\nmanager server-resolution live e2e: ${pass} checks passed`);
} finally {
  for (const cp of kids) {
    try {
      cp.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}
process.exit(0);
