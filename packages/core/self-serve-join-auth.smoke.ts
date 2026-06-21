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
  CONTROL_SELF_SERVICE,
  type Delivery,
} from "./src/index.js";

const PORT = 14245;
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  a.on("message", (m, d: Delivery) => {
    got.push(`#${m.channel}:${m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}`);
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
    "boot channel still delivered via durable, exactly once",
    got.filter((g) => g === "#general:on general").length === 1,
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

  // Durable-covered leave with NO provisioner is REFUSED honestly (it can't stop durable delivery).
  let leaveRefused = false;
  try {
    await a.leaveChannel("general");
  } catch {
    leaveRefused = true;
  }
  check("durable-covered leave with no provisioner is refused (honest)", leaveRefused);
  got.length = 0;
  await pub.multicast("general still flows", { channel: "general" });
  await wait(300);
  check("refused leave means the channel still delivers (no false 'left')", got.some((g) => g.includes("general still flows")), got);

  // ───────────────────── Phase 2 — control responder present (manager) ─────────────────────
  // Wire a minimal manager: serve ctl.self setChannels by moving the caller's durable filter.
  pub.serveControl(CONTROL_SELF_SERVICE, async (req) => {
    if (req.op === "setChannels" && Array.isArray((req.args as { channels?: unknown })?.channels)) {
      await pub.setChatFilterFor(req.from.id, (req.args as { channels: string[] }).channels);
      return { ok: true };
    }
    return { ok: false, error: "unknown op" };
  });
  await wait(200);

  got.length = 0;
  const r2 = await a.joinChannel("review.db");
  check("manager-present joinChannel(review.db) succeeds", r2.joined === true, r2);
  check("manager-present join reports durable:true (backstop established)", r2.durable === true, r2);

  await pub.multicast("dual-path once", { channel: "review.db" });
  await wait(500);
  check(
    "manager-present join delivers EXACTLY ONCE (no double across core-sub + durable)",
    got.filter((g) => g === "#review.db:dual-path once").length === 1,
    got,
  );

  // With a provisioner present, leaving a durable-covered channel succeeds and stops delivery.
  await a.leaveChannel("review.db");
  got.length = 0;
  await pub.multicast("gone", { channel: "review.db" });
  await wait(400);
  check("manager-present leave stops delivery", !got.some((g) => g.includes("gone")), got);

  await a.stop();
  await pub.stop();
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  srv.kill("SIGKILL");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nSELF-SERVE-JOIN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
