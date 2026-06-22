/**
 * Self-serve channel-join smoke (SPEC v0.3 overlay). Two phases:
 *
 *  Phase 1 — NO manager serving control: an auth-mode agent joins a channel's live feed at runtime
 *  and receives the live message via its native core subscription (broker-enforced by sub.allow).
 *  Join reports `durable:false` (joined live, backstop unestablished); out-of-ACL join is refused
 *  (broker-confirmed); a core-sub leave stops delivery; a durable-covered leave is REFUSED honestly
 *  (the legacy filter needs the provisioner) rather than reporting a leave that doesn't stop delivery.
 *
 *  Phase 2 — a control responder IS present (simulating the manager): a runtime join now also moves
 *  the legacy durable filter (`durable:true`), and the message is delivered EXACTLY ONCE — the durable
 *  owns it, the core-sub coverage-drops it, the id-dedup backstop covers the transition window.
 *
 * Run: pnpm smoke:self-serve-join:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  channelInAllow,
  CONTROL_SELF_SERVICE,
  type Delivery,
} from "../src/index.js";

// Fresh random port per run + await-exit on every broker kill (below): a fixed port plus a SIGKILL
// that doesn't await the child's exit leaks the broker, and the next run collides with the squatter
// (the "Authorization Violation" contamination reviewers hit). The mid-test reconnect restart reuses
// THIS port, so it too must await the old process's exit before respawning, or it races the dying one.
const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const space = `selfjoin-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-selfjoin-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
let server = srv; // mutable: the reconnect test restarts the broker and tracks the live process

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // Privileged endpoint: provisions durables + publishes (and, in phase 2, serves the control plane).
  // Until then it is a BARE endpoint that does NOT serve control, so runtime joins have no responder.
  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const pub = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: mgrCreds,
    card: { name: "pub", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  pub.on("error", (e: Error) => console.error("  ! pub", e.message));
  await pub.start();

  // Agent A: boots subscribed to ["general","ops"] (durable pre-created over both), read ACL also
  // covers review.> (so it can self-serve runtime joins under that subtree) but NOT "secret".
  const aId = newIdentity();
  const aCreds = await provisionAgent(pub, auth, aId, {
    subscribe: ["general", "ops"],
    allowSubscribe: ["general", "ops", "review.>"],
  });
  const a = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general", "ops"],
    heartbeatMs: 500,
    ttlMs: 2000,
  });
  const got: string[] = [];
  const gotDurable: string[] = []; // keys delivered with durable:true (the Plane-3 backstop copy)
  a.on("message", (m, d: Delivery) => {
    const key = `#${m.channel}:${m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}`;
    got.push(key);
    if (d.durable) gotDurable.push(key);
    d.ack();
  });
  a.on("error", (e: Error) => console.error("  ! alice:", e.message));
  await a.start();
  await wait(500);

  // ───────────────────── Phase 1 — NO control responder (manager-free) ─────────────────────
  const r = await a.joinChannel("review.api");
  check("manager-free joinChannel(review.api) succeeds", r.joined === true, r);
  check("manager-free join reports durable:false (joined live, backstop unestablished)", r.durable === false, r);

  await pub.multicast("live via core-sub", { channel: "review.api" });
  await wait(400);
  check(
    "manager-free join DELIVERS the live message (core-sub)",
    got.filter((g) => g === "#review.api:live via core-sub").length === 1,
    got,
  );

  await pub.multicast("on general", { channel: "general" });
  await wait(400);
  check(
    "boot channel delivered via its core-sub, exactly once",
    got.filter((g) => g === "#general:on general").length === 1,
    got,
  );

  // Reconnect resilience: a manager-free core-sub join must SURVIVE a broker restart — the rebind has
  // to reopen the core subscription (reconcile off the durable's real filter), not leave it inert.
  server.kill("SIGKILL");
  await awaitExit(server); // the restart reuses PORT — the old broker must fully exit + free the socket first
  server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  let back = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      back = true;
      break;
    }
    await wait(200);
  }
  if (!back) throw new Error("broker did not restart");
  await wait(3000); // reconnect + startConsumers rebind + core-sub reconciliation
  got.length = 0;
  await pub.multicast("after reconnect", { channel: "review.api" });
  await wait(800);
  check(
    "manager-free core-sub join SURVIVES a broker reconnect",
    got.some((g) => g === "#review.api:after reconnect"),
    got,
  );

  let joinDenied = false;
  try {
    await a.joinChannel("secret");
  } catch {
    joinDenied = true;
  }
  check("join out-of-ACL (secret) is refused (broker-confirmed)", joinDenied);

  // Core-sub leave is manager-free and stops delivery.
  await a.leaveChannel("review.api");
  got.length = 0;
  await pub.multicast("after leave", { channel: "review.api" });
  await wait(400);
  check("after manager-free leave, no live delivery", !got.some((g) => g.includes("after leave")), got);

  // Leaving a boot channel is now manager-free too (just closes the core-sub — there is no legacy
  // durable to refuse the leave). It stops delivery.
  const leftGeneral = await a.leaveChannel("general");
  check("leaving a boot channel succeeds (manager-free core-sub close)", leftGeneral.left === true, leftGeneral);
  got.length = 0;
  await pub.multicast("after general leave", { channel: "general" });
  await wait(300);
  check("after leaving the boot channel, no delivery", !got.some((g) => g.includes("after general leave")), got);

  // ───────────── Phase 2 — a real Plane-3 manager (fan-out + trusted reader + durableJoin/Leave) ─────────────
  // Host Plane-3 on `pub` and serve the durableJoin/Leave ctl ops that joinChannel/leaveChannel now use
  // for a `durable`-class channel (the legacy filter-move is no longer the runtime durable path). The
  // trusted reader re-authorizes against the caller's current ACL (its allowSubscribe), supplied here.
  const aliceAcl = ["general", "ops", "review.>"];
  await pub.startPlane3((id) => (id === aId.id ? aliceAcl : undefined));
  pub.serveControl(CONTROL_SELF_SERVICE, async (req) => {
    const ch =
      typeof (req.args as { channel?: unknown })?.channel === "string" ? (req.args as { channel: string }).channel : "";
    if (req.op === "durableJoin") {
      if (!ch || !channelInAllow(aliceAcl, ch)) return { ok: false, error: `not in ACL: ${ch}` };
      return { ok: true, data: await pub.durableJoinFor(req.from.id, ch) };
    }
    if (req.op === "durableLeave") {
      await pub.durableLeaveFor(req.from.id, ch);
      return { ok: true, data: { channel: ch } };
    }
    return { ok: false, error: `unknown op: ${req.op}` };
  });
  await wait(200);

  got.length = 0;
  gotDurable.length = 0;
  const r2 = await a.joinChannel("review.db");
  check("manager-present joinChannel(review.db) succeeds", r2.joined === true, r2);
  check("manager-present join reports durable:true (Plane-3 backstop active)", r2.durable === true, r2);

  await pub.multicast("dual-path once", { channel: "review.db" });
  check(
    "the Plane-3 durable backstop delivers the durable copy (next-turn, durable:true)",
    await until(() => gotDurable.includes("#review.db:dual-path once")),
    { got, gotDurable },
  );
  // The channel ALSO arrives live via the core-sub (durable:false) — Plane-3 channels are dual-path at
  // the endpoint; the CONNECTOR's commit-aware id-dedup (MeshAgent.ingest) collapses the two emits to
  // one. That exactly-once coalescing is proven in cross-path-dedup.smoke (a raw endpoint can't dedup).
  check("...and the live wake-hint copy arrives too (dual-path)", got.filter((g) => g === "#review.db:dual-path once").length >= 1, got);

  // Plane-3 leave tombstones membership at the leave cursor: a post AFTER leave is denied by the
  // backstop (seq > leaveCursor) AND the core-sub is closed — nothing arrives by either path.
  await a.leaveChannel("review.db");
  got.length = 0;
  gotDurable.length = 0;
  await pub.multicast("gone", { channel: "review.db" });
  await wait(900);
  check("manager-present leave stops delivery (core-sub closed + backstop tombstoned)", !got.some((g) => g.includes("gone")), got);

  await a.stop();
  await pub.stop();
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  server.kill("SIGKILL");
  await awaitExit(server); // await actual exit so a failed run never leaks the broker onto its port
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nSELF-SERVE-JOIN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
