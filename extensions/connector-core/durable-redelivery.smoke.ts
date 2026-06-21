/**
 * Durable ack-commit / redelivery-suppression against a REAL broker (no test runner).
 *
 * The overlay dropped pre-commit "seen" acking and now relies on the inbox's retained ack handle:
 * drainInbox() must call the REAL JetStream JsMsg.ack(), it must reach the broker, and that ack must
 * suppress ack_wait redelivery. cross-path-dedup.smoke.ts proves the in-process coalescing with
 * SYNTHETIC no-op acks and never connects (servers :1); self-serve-join-auth Phase 2 acks on delivery
 * and publishes once against the default 60s ack_wait, so it can never observe a redelivery. So the
 * load-bearing invariant — "a real durable ack commits exactly once and stops redelivery" — was
 * asserted by ZERO smoke against a real broker. This closes that gap with a full MeshAgent + a real
 * nats-server + a SHORT ack_wait (so redelivery is observable in seconds).
 *
 * Mutation sensitivity: deliveries are counted on the raw endpoint "message" event (fires per physical
 * delivery), so it counts EVERY physical redelivery independently of ingest — visible even though
 * ingest coalesces the redelivery away and inboxCount stays 1.
 *  - un-acked: the count climbs past 1 (durable redelivers) and inboxCount stays 1 (dedup coalesces it);
 *  - after drainInbox acks: the count FREEZES (the real ack committed). If drain's ack were a no-op
 *    (the pre-commit-dedup regression), redelivery would continue (each acked-and-dropped via
 *    handledIds) and the count would keep climbing — so this test fails loudly on that regression.
 * Run: pnpm smoke:durable-redelivery
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable, type CotalMessage } from "@cotal-ai/core";
import { MeshAgent } from "./src/agent.js";
import type { AgentConfig } from "./src/config.js";

// Random port + await-exit teardown (a SIGKILLed broker does not free its socket synchronously, so a
// fixed port leaks across back-to-back runs — the contamination the feature smokes were hardened against).
const PORT = 20000 + Math.floor(Math.random() * 40000);
const servers = `nats://127.0.0.1:${PORT}`;
const space = "redelivsmoke";
const ACK_WAIT_MS = 1500; // short, so an un-acked message redelivers within the test's waits
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(stepMs);
  return cond();
};
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

const dir = mkdtempSync(join(tmpdir(), "cotal-redeliv-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space,
  name: "Otto",
  role: "generalist",
  servers,
  subscribe: ["dur"], // a boot/subscribed channel → durable consumer (real ack), NOT core-sub
  allowSubscribe: ["dur"],
  allowPublish: ["dur"],
  kind: "agent",
  tls: false,
  id: "otto_agent",
  ackWaitMs: ACK_WAIT_MS,
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});
// Count PHYSICAL deliveries (incl. redeliveries) on the raw endpoint event, keyed by body text.
const deliveries = new Map<string, number>();
agent.ep.on("message", (m: CotalMessage) => {
  const t = textOf(m);
  deliveries.set(t, (deliveries.get(t) ?? 0) + 1);
});

const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: ["dur"] });
pub.on("error", () => {});

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { dur: { replay: false } } } });

  await pub.start();
  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected", agent.connected === true);
  await sleep(300);

  // ---- one durable message, NOT yet drained ----
  await pub.multicast("m1", { channel: "dur" });
  check("durable message is delivered and buffered un-acked", await until(() => agent.inboxCount() === 1 && (deliveries.get("m1") ?? 0) >= 1));

  // ---- negative control: an un-acked durable message redelivers after ack_wait ----
  // (Also proves the ackWaitMs passthrough took effect: at the default 60s this would not redeliver in time.)
  const redelivered = await until(() => (deliveries.get("m1") ?? 0) >= 2, ACK_WAIT_MS * 4);
  check(
    "un-acked durable message REDELIVERS after ack_wait (real broker, short ack_wait active)",
    redelivered,
    { deliveries: deliveries.get("m1") },
  );
  check(
    "redelivery is coalesced in-process: still exactly one inbox entry (real-broker durable dedup)",
    agent.inboxCount() === 1,
    { inbox: agent.inboxCount() },
  );

  // ---- drain (the REAL ack) then assert redelivery STOPS ----
  const drained = agent.drainInbox();
  check("drainInbox surfaces the message exactly once", drained.length === 1 && drained[0].text === "m1");
  check("inbox empty after drain", agent.inboxCount() === 0);

  const afterDrain = deliveries.get("m1") ?? 0;
  await sleep(ACK_WAIT_MS + 1500); // well past another ack_wait window
  check(
    "the real ack COMMITTED: no further redelivery after drain (count frozen)",
    (deliveries.get("m1") ?? 0) === afterDrain,
    { before: afterDrain, after: deliveries.get("m1") },
  );
  check("inbox stays empty (acked message does not re-surface)", agent.inboxCount() === 0);

  console.log(`\nDURABLE-REDELIVERY SMOKE PASSED ✅  (${pass} checks)`);
  await agent.stop();
  await pub.stop();
} finally {
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
    srv.once("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
