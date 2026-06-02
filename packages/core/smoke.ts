/**
 * End-to-end smoke test (no test runner) — run with: pnpm smoke
 * Requires a nats-server running locally (pnpm swarl up).
 */
import { SwarlEndpoint, isReachable } from "./src/index.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait for NATS to be reachable (handles a just-started server).
for (let i = 0; i < 50; i++) {
  if (await isReachable()) break;
  await wait(200);
}

const space = "smoke";
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
b.on("message", (m) => {
  const text = m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  got.push(`${m.to ? "DM" : "#" + m.channel}:${m.from.name}:${text}`);
});

await a.start();
await b.start();
await wait(800);

console.log("roster(a):", a.getRoster().map((p) => `${p.card.name}=${p.status}`));
console.log("roster(b):", b.getRoster().map((p) => `${p.card.name}=${p.status}`));

await a.setStatus("working");
await a.broadcast("hello team", { channel: "general" });
await wait(300);

const bob = a.getRoster().find((p) => p.card.name === "bob");
if (bob) await a.dm(bob.card.id, "psst bob");
await wait(300);

const aliceInB = b.getRoster().find((p) => p.card.name === "alice");
console.log("bob received:", got);
console.log("alice status seen by b:", aliceInB?.status);

await b.stop();
await wait(500);
const bobInA = a.getRoster().find((p) => p.card.name === "bob");
console.log("bob status seen by a after stop:", bobInA?.status);

const ok =
  a.getRoster().length === 2 &&
  got.some((g) => g.startsWith("#general")) &&
  got.some((g) => g.startsWith("DM")) &&
  aliceInB?.status === "working" &&
  bobInA?.status === "offline";

console.log(ok ? "\nSMOKE OK ✅" : "\nSMOKE FAILED ❌");
await a.stop();
process.exit(ok ? 0 : 1);
