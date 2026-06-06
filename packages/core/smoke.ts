/**
 * End-to-end smoke test (no test runner) — run with: pnpm smoke
 * Requires a nats-server running locally (pnpm swarl up).
 */
import { randomUUID } from "node:crypto";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  SwarlEndpoint,
  isReachable,
  chatStream,
  dmStream,
  taskStream,
  presenceBucket,
  type Delivery,
} from "./src/index.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait for NATS to be reachable (handles a just-started server).
for (let i = 0; i < 50; i++) {
  if (await isReachable()) break;
  await wait(200);
}

// Unique space per run → isolated streams, no cross-run history bleed, deterministic.
const space = `smoke-${randomUUID().slice(0, 8)}`;
const a = new SwarlEndpoint({
  space,
  card: { name: "alice", role: "planner", kind: "agent" },
  heartbeatMs: 500,
  ttlMs: 2000,
});
const b = new SwarlEndpoint({
  space,
  card: { name: "bob", role: "builder", kind: "agent" },
  heartbeatMs: 500,
  ttlMs: 2000,
});

const got: string[] = [];
b.on("message", (m, d: Delivery) => {
  const text = m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  const kind = m.to ? "DM" : m.toService ? "ANY:" + m.toService : "#" + (m.channel ?? "");
  got.push(`${kind}:${m.from.name}:${text}`);
  d.ack(); // recorded = surfaced
});

await a.start();
await b.start();
await wait(800);

console.log("roster(a):", a.getRoster().map((p) => `${p.card.name}=${p.status}`));
console.log("roster(b):", b.getRoster().map((p) => `${p.card.name}=${p.status}`));

await a.setStatus("working");
await a.multicast("hello team", { channel: "general" });
await wait(300);

const bob = a.getRoster().find((p) => p.card.name === "bob");
if (bob) await a.unicast(bob.card.id, "psst bob");
await wait(300);

// anycast to the "builder" service — bob (role: builder) should receive it
await a.anycast("builder", "build the thing");
await wait(300);

// Durability: a DM sent to carol BEFORE she connects must still arrive (the stream holds it).
const carolId = randomUUID();
await a.unicast(carolId, "stored while you were away");
await wait(200);
const carol = new SwarlEndpoint({
  space,
  card: { id: carolId, name: "carol", role: "tester", kind: "agent" },
  heartbeatMs: 500,
  ttlMs: 2000,
});
const carolGot: string[] = [];
carol.on("message", (m, d: Delivery) => {
  carolGot.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
  d.ack();
});
await carol.start();
await wait(600);
console.log("carol received (DM sent while offline):", carolGot);

const aliceInB = b.getRoster().find((p) => p.card.name === "alice");
console.log("bob received:", got);
console.log("alice status seen by b:", aliceInB?.status);

await b.stop();
await wait(500);
const bobInA = a.getRoster().find((p) => p.card.name === "bob");
console.log("bob status seen by a after stop:", bobInA?.status);

const ok =
  got.some((g) => g.startsWith("#general")) &&
  got.some((g) => g.startsWith("DM")) &&
  got.some((g) => g.startsWith("ANY:builder")) &&
  carolGot.some((g) => g.includes("stored while you were away")) &&
  aliceInB?.status === "working" &&
  bobInA?.status === "offline";

console.log(ok ? "\nSMOKE OK ✅" : "\nSMOKE FAILED ❌");
await carol.stop();
await a.stop();

// Tear down this run's (uniquely-named) streams + presence bucket — race-free, no litter.
const cleanup = await connect();
const jsm = await jetstreamManager(cleanup);
for (const s of [chatStream(space), dmStream(space), taskStream(space), `KV_${presenceBucket(space)}`]) {
  await jsm.streams.delete(s).catch(() => {});
}
await cleanup.close();
process.exit(ok ? 0 : 1);
