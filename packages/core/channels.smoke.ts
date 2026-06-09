/**
 * Channel-registry test (open mode — no auth). Spins up its OWN nats-server and verifies the
 * registry + replay mechanism end-to-end:
 *   - registry round-trip: seed → read, effective-replay precedence, merge-on-write, validation;
 *   - replay on join: a replay channel backfills history (as `historical`), a no-replay one doesn't;
 *   - the tail drop: pre-join history on a no-replay channel is suppressed (not leaked live);
 *   - dynamic join/leave: consumers.update mid-session, idempotent re-join, can't-leave-last;
 *   - rebind: a reconnect is a pure tail resume — no re-backfill.
 * Run: pnpm smoke:channels
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, seedChannelRegistry, readChannelRegistry, effectiveReplay, validateChannelConfig,
  isReachable, type CotalMessage, type Delivery, type MessageMeta,
} from "./src/index.js";

const PORT = 14224;
const servers = `nats://127.0.0.1:${PORT}`;
const space = "chansmoke";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

interface Rec { channel?: string; text: string; historical: boolean }
function recorder(name: string, id: string, channels: string[]) {
  const got: Rec[] = [];
  const ep = new CotalEndpoint({ space, servers, card: { name, kind: "agent", id }, channels });
  ep.on("error", () => {});
  ep.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => {
    got.push({ channel: m.channel, text: textOf(m), historical: meta?.historical ?? false });
    d.ack();
  });
  return { ep, got };
}
const has = (got: Rec[], text: string) => got.filter((g) => g.text === text);

const dir = mkdtempSync(join(tmpdir(), "cotal-chan-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  // ---- registry round-trip ----
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { log: { replay: true }, incident: { replay: true }, chat: { replay: false }, review: { description: "Design critique", instructions: "Be specific." } } } });
  const reg = await readChannelRegistry({ servers, space });
  check("registry round-trips", reg.defaults?.replay === false && reg.channels?.log.replay === true && reg.channels?.review.description === "Design critique");
  check("effective replay precedence", effectiveReplay(reg.channels!.log, reg.defaults) === true && effectiveReplay(reg.channels!.review, reg.defaults) === false && effectiveReplay(undefined, undefined) === true);
  await seedChannelRegistry({ servers, space, file: { channels: { review: { description: "Critique v2" } } } });
  const reg2 = await readChannelRegistry({ servers, space });
  check("merge-on-write keeps other fields", reg2.channels?.review.description === "Critique v2" && reg2.channels?.review.instructions === "Be specific.");
  assert.throws(() => validateChannelConfig({ description: "x".repeat(1000) }), /too long/);
  check("validation rejects oversize", true);

  // ---- replay on join ----
  const A = new CotalEndpoint({ space, servers, card: { name: "A", kind: "agent", id: "A_pub" }, channels: ["log", "chat", "general", "incident"] });
  A.on("error", () => {});
  await A.start();
  await sleep(300);
  await A.multicast("log-hist-1", { channel: "log" });
  await A.multicast("log-hist-2", { channel: "log" });
  await A.multicast("chat-hist-1", { channel: "chat" });
  await A.multicast("incident-hist-1", { channel: "incident" });
  await sleep(300);

  const B = recorder("B", "B_join", ["log", "chat"]);
  await B.ep.start();
  await sleep(400);
  check("replay channel backfills history (historical)", B.got.filter((g) => g.channel === "log" && g.historical).length === 2);
  check("no-replay channel does not backfill", has(B.got, "chat-hist-1").length === 0);

  B.got.length = 0;
  await A.multicast("log-live-1", { channel: "log" });
  await A.multicast("chat-live-1", { channel: "chat" });
  await sleep(500);
  check("live delivery, no dup, not historical", has(B.got, "log-live-1").length === 1 && has(B.got, "log-live-1")[0].historical === false && has(B.got, "chat-live-1").length === 1);

  // ---- dynamic join (replay) + idempotent ----
  B.got.length = 0;
  const jr = await B.ep.joinChannel("incident");
  await sleep(300);
  check("dynamic join backfills replay channel", jr.joined === true && jr.backfilled === 1 && B.got.filter((g) => g.channel === "incident" && g.historical).length === 1);
  check("re-join is a no-op", JSON.stringify(await B.ep.joinChannel("incident")) === JSON.stringify({ joined: false, backfilled: 0 }));

  // ---- dynamic join (no-replay) → tail drop suppresses pre-join history ----
  B.got.length = 0;
  await A.multicast("general-hist", { channel: "general" });
  await sleep(200);
  const jg = await B.ep.joinChannel("general");
  await sleep(400);
  check("no-replay join: no backfill + pre-join history suppressed by the drop", jg.backfilled === 0 && has(B.got, "general-hist").length === 0);
  await A.multicast("general-live", { channel: "general" });
  await sleep(400);
  check("live delivery works after no-replay join", has(B.got, "general-live").length === 1);

  // ---- dynamic leave ----
  B.got.length = 0;
  await B.ep.leaveChannel("chat");
  await sleep(200);
  await A.multicast("chat-after-leave", { channel: "chat" });
  await sleep(400);
  check("leave stops delivery", has(B.got, "chat-after-leave").length === 0);
  await B.ep.leaveChannel("incident");
  await B.ep.leaveChannel("general");
  await assert.rejects(() => B.ep.leaveChannel("log"), /only channel/);
  check("can't leave the last channel", true);

  // ---- rebind = pure resume, no re-backfill ----
  await B.ep.stop();
  await sleep(300);
  const B2 = recorder("B", "B_join", ["log"]);
  await B2.ep.start();
  await sleep(500);
  check("rebind does not re-backfill history", B2.got.filter((g) => g.historical).length === 0);

  await A.stop();
  await B2.ep.stop();
  console.log(`\nCHANNEL REGISTRY TESTS PASSED ✅  (${pass} checks)`);
} finally {
  srv.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
