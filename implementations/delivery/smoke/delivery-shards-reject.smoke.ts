/**
 * delivery shards-reject smoke. The partition() seam ships at N=1 only; operating sharded delivery is
 * deferred (a hash partition isn't expressible as a NATS sub.allow/durable filter under the flat chat
 * grammar — see core-sub-fabric.md). `cotal deliver --shards >1` (or a non-zero --shard) must THROW
 * loudly at the entrypoint, before connecting or binding anything. No broker needed — the guard is the
 * first thing runDelivery does.
 *
 * Run: pnpm smoke:delivery-shards-reject
 */
import { runDelivery } from "../src/delivery.js";

let pass = 0,
  fail = 0;
const rejects = async (name: string, argv: string[]) => {
  try {
    await runDelivery(argv);
    fail++;
    console.log(`  ✗ FAIL: ${name} — expected a throw, got none`);
  } catch (e) {
    const ok = /shards|N=1|not supported|sharded/i.test((e as Error).message);
    if (ok) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ FAIL: ${name} — threw the wrong error: ${(e as Error).message}`); }
  }
};

await rejects("--shards 2 is rejected before binding", ["--space", "x", "--shards", "2"]);
await rejects("--shard 1 (non-zero) is rejected before binding", ["--space", "x", "--shard", "1"]);

console.log(`\nDELIVERY-SHARDS-REJECT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
