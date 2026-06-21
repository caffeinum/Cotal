/**
 * Self-serve channel-join smoke (SPEC v0.3 overlay) — the headline behaviour: an AUTH-mode agent
 * joins a channel's live feed at runtime WITH NO MANAGER serving control, and actually receives the
 * live message via its native core subscription (broker-enforced by sub.allow). Also: a denied
 * (out-of-ACL) join is refused (broker-confirmed), a manager-free leave stops delivery, and the boot
 * channel still delivers via the legacy durable (no regression).
 *
 * "No manager" = no endpoint serves the `ctl.self` control plane, so the legacy mediated
 * setChannels has no responder; the join must still work off the core-sub alone.
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

  // Privileged endpoint: provisions durables + publishes. It is a BARE endpoint — it does NOT serve
  // the control plane (only the Manager supervisor does), so runtime joins have NO control responder.
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

  // Agent A: boots subscribed to ["general"] (durable pre-created), read ACL also covers review.>
  // (so it can self-serve a runtime join under that subtree) but NOT "secret".
  const aId = newIdentity();
  const aCreds = await provisionAgent(pub, auth, aId, {
    subscribe: ["general"],
    allowSubscribe: ["general", "review.>"],
  });
  const a = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general"],
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

  // ── Headline: a runtime join with NO control responder must succeed off the core-sub. ──
  const r = await a.joinChannel("review.api");
  check("manager-free joinChannel(review.api) succeeds", r.joined === true, r);

  await pub.multicast("live via core-sub", { channel: "review.api" });
  await wait(400);
  check(
    "manager-free join DELIVERS the live message (core-sub)",
    got.some((g) => g === "#review.api:live via core-sub"),
    got,
  );

  // Boot channel still rides the legacy durable — delivered, and exactly once (core-sub never grabs
  // a boot channel, so no double-emit).
  await pub.multicast("on general", { channel: "general" });
  await wait(400);
  check(
    "boot channel still delivered via durable, exactly once",
    got.filter((g) => g === "#general:on general").length === 1,
    got,
  );

  // Out-of-ACL join is refused — broker-confirmed (the sub.allow violation is async).
  let denied = false;
  try {
    await a.joinChannel("secret");
  } catch {
    denied = true;
  }
  check("join out-of-ACL (secret) is refused (broker-confirmed)", denied);
  await pub.multicast("should not arrive", { channel: "secret" });
  await wait(300);
  check(
    "no delivery from the refused out-of-ACL channel",
    !got.some((g) => g.includes("should not arrive")),
    got,
  );

  // Manager-free leave stops the live feed.
  await a.leaveChannel("review.api");
  got.length = 0;
  await pub.multicast("after leave", { channel: "review.api" });
  await wait(400);
  check("after manager-free leave, no live delivery", !got.some((g) => g.includes("after leave")), got);

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
