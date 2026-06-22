/**
 * One-shot send commands (`cotal dm` / `msg` / `ask`) — live e2e (no test runner). Needs a local
 * nats-server (`pnpm cotal up --open`). Starts a receiver peer, runs the real CLI as subprocesses
 * against it (so arg-parse, registration, exit codes, and the negative path are all covered — what
 * `packages/core/smoke.ts` can't reach), and asserts each delivery arrives. Run: pnpm smoke:send
 *
 * Uses a unique space per run, so it leaves no cross-run state behind (the dev server is torn down
 * with it); no explicit stream teardown needed here.
 */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CotalEndpoint, isReachable, type CotalMessage, type Delivery } from "@cotal-ai/core";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

for (let i = 0; i < 50; i++) {
  if (await isReachable()) break;
  await wait(200);
}
if (!(await isReachable())) {
  console.error("no nats-server at :4222 — run `pnpm cotal up --open` first");
  process.exit(1);
}

const root = fileURLToPath(new URL("../../", import.meta.url)); // implementations/cli/ → repo root
const cli = fileURLToPath(new URL("../../bin/cotal.ts", import.meta.url));
// Run the CLI through node's tsx loader so no build step / .bin resolution is needed.
const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cli, ...args],
      { cwd: root },
      (err, stdout, stderr) =>
        resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
    );
  });

const space = `sendsmoke-${randomUUID().slice(0, 8)}`;
const bob = new CotalEndpoint({
  space,
  card: { name: "bob", role: "reviewer", kind: "agent" },
  channels: ["general"],
  heartbeatMs: 500,
  ttlMs: 10_000, // generous so presence survives while subprocesses run
});
const got: string[] = [];
bob.on("message", (m: CotalMessage, d: Delivery) => {
  const text = m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  const kind = m.to ? "DM" : m.toService ? "ANY:" + m.toService : "#" + (m.channel ?? "");
  got.push(`${kind}:${text}`);
  d.ack();
});
bob.on("error", (e: Error) => console.error("! bob:", e.message));
await bob.start();
await wait(800); // let presence settle so `dm bob` resolves the name → id

// Space-free random tokens so they're single positionals (no quoting needed).
const U = "u-" + randomUUID().slice(0, 6);
const M = "m-" + randomUUID().slice(0, 6);
const A = "a-" + randomUUID().slice(0, 6);

try {
  const rdm = await run(["dm", "bob", U, "--space", space]);
  const rmsg = await run(["msg", "general", M, "--space", space]);
  const rask = await run(["ask", "reviewer", A, "--space", space]);
  await wait(700);

  check("`cotal dm` exits 0", rdm.code === 0, rdm.stderr);
  check("`cotal msg` exits 0", rmsg.code === 0, rmsg.stderr);
  check("`cotal ask` exits 0", rask.code === 0, rask.stderr);
  check("bob received the DM", got.includes(`DM:${U}`), got);
  check("bob received the #general broadcast", got.includes(`#general:${M}`), got);
  check("bob received the anycast to reviewer", got.includes(`ANY:reviewer:${A}`), got);

  // Negative: a missing target is a non-zero exit with a clear message.
  const rneg = await run(["dm", "nobody-here", "x", "--space", space]);
  check("`cotal dm` to an absent agent exits non-zero", rneg.code !== 0, rneg.code);
  check("`cotal dm` to an absent agent says 'no agent'", /no agent/i.test(rneg.stderr), rneg.stderr);

  console.log(`\nsend smoke: ${pass} checks passed`);
} finally {
  await bob.stop();
}
process.exit(0);
