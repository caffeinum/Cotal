/**
 * End-to-end smoke test (no test runner) — run with: pnpm smoke
 * Requires a nats-server running locally (pnpm cotal up).
 */
import { randomUUID } from "node:crypto";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint,
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
const a = new CotalEndpoint({
  space,
  card: { name: "alice", role: "planner", kind: "agent" },
  heartbeatMs: 500,
  ttlMs: 2000,
});
const b = new CotalEndpoint({
  space,
  card: { name: "bob", role: "builder", kind: "agent" },
  heartbeatMs: 500,
  ttlMs: 2000,
});
a.on("error", (e: Error) => console.error("! alice:", e.message));
b.on("error", (e: Error) => console.error("! bob:", e.message));

const got: string[] = [];
let bobSawMentions: string[] | undefined;
b.on("message", (m, d: Delivery) => {
  const text = m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  const kind = m.to ? "DM" : m.toService ? "ANY:" + m.toService : "#" + (m.channel ?? "");
  got.push(`${kind}:${m.from.name}:${text}`);
  if (text === "hello team") bobSawMentions = m.mentions; // mentions ride the multicast payload
  d.ack(); // recorded = surfaced
});

await a.start();
await b.start();
await wait(800);

console.log("roster(a):", a.getRoster().map((p) => `${p.card.name}=${p.status}`));
console.log("roster(b):", b.getRoster().map((p) => `${p.card.name}=${p.status}`));

await a.setStatus("working");
// Mentions ride the multicast payload: normalized (trim + lowercase + dedupe) on the wire,
// and the field is omitted entirely when empty.
const sent = await a.multicast("hello team", { channel: "general", mentions: ["BOB", " bob ", "carol", ""] });
const omitted = await a.multicast("noping", { channel: "general", mentions: [""] });
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
const carol = new CotalEndpoint({
  space,
  card: { id: carolId, name: "carol", role: "tester", kind: "agent" },
  heartbeatMs: 500,
  ttlMs: 2000,
});
carol.on("error", (e: Error) => console.error("! carol:", e.message));
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

const mentionsNormalized = JSON.stringify(sent.mentions) === JSON.stringify(["bob", "carol"]);
const emptyOmitted = omitted.mentions === undefined;
const bobSawMention = bobSawMentions?.includes("bob") === true;
console.log("mention wire:", { sent: sent.mentions, omitted: omitted.mentions, bobSaw: bobSawMentions });

const ok =
  got.some((g) => g.startsWith("#general")) &&
  got.some((g) => g.startsWith("DM")) &&
  got.some((g) => g.startsWith("ANY:builder")) &&
  carolGot.some((g) => g.includes("stored while you were away")) &&
  mentionsNormalized &&
  emptyOmitted &&
  bobSawMention &&
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
