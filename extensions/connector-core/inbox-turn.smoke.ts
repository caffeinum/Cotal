/**
 * Smoke test for the InboxTurn ack-on-surface helper (no NATS/LLM needed): drives it against
 * a fake inbox and asserts the surface/ack invariants the embed adapters rely on.
 *
 *   pnpm smoke:inbox
 */
import { InboxTurn, type InboxSource } from "./src/inbox-turn.js";
import type { InboxItem } from "./src/agent.js";

function item(id: string, fromId: string, kind: InboxItem["kind"] = "dm"): InboxItem {
  return { id, ts: 0, fromId, fromName: fromId, kind, mentionsMe: false, text: id };
}

class FakeInbox implements InboxSource {
  items: InboxItem[] = [];
  acked: InboxItem[] = [];
  peekInbox(): InboxItem[] {
    return [...this.items];
  }
  drainInbox(limit?: number): InboxItem[] {
    const n = limit && limit > 0 ? Math.min(limit, this.items.length) : this.items.length;
    const taken = this.items.splice(0, n);
    this.acked.push(...taken);
    return taken;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const ids = (xs: InboxItem[]): string => xs.map((x) => x.id).join(",");
const sameScope = (a: InboxItem, b: InboxItem): boolean =>
  a.fromId === b.fromId && a.kind === b.kind;

// 1) drop leading non-actionable, start on the front, commit acks exactly the origin
{
  const fake = new FakeInbox();
  fake.items = [item("echo", "self"), item("b", "alice")];
  const turn = new InboxTurn(fake);
  turn.drop((i) => i.fromId === "self");
  assert(ids(fake.acked) === "echo", "drop ack-drops the self echo");
  assert(turn.start()?.id === "b", "start surfaces the front actionable");
  assert(turn.count === 1, "surfaced exactly the origin");
  turn.commit();
  assert(ids(fake.acked) === "echo,b", "commit acks the origin");
  assert(fake.items.length === 0 && !turn.inFlight, "inbox drained, turn idle");
}

// 2) extend folds the front-contiguous same-scope run, stops at a different-scope gap
{
  const fake = new FakeInbox();
  fake.items = [item("1", "alice"), item("2", "alice"), item("3", "bob"), item("4", "alice")];
  const turn = new InboxTurn(fake);
  assert(turn.start()?.id === "1", "origin = 1");
  const folded = turn.extend(sameScope);
  assert(ids(folded) === "2", "folds only contiguous same-scope #2, stops at the #3 gap");
  assert(turn.count === 2, "surfaced run is the 2-item prefix");
  turn.commit();
  assert(ids(fake.acked) === "1,2", "commit acks exactly the surfaced prefix [1,2]");
  assert(ids(fake.items) === "3,4", "cross-scope #3 and gapped #4 stay on the stream");
}

// 3) abandon acks nothing — the surfaced run redelivers
{
  const fake = new FakeInbox();
  fake.items = [item("x", "alice")];
  const turn = new InboxTurn(fake);
  turn.start();
  turn.abandon();
  assert(fake.acked.length === 0, "abandon acks nothing");
  assert(ids(fake.items) === "x" && !turn.inFlight, "item stays on the stream; turn idle");
}

// 4) MAX_INBOX front-eviction guard: if the surfaced prefix is evicted mid-turn (overflow
//    already acked it), commit must NOT drain the newer front items that took its place
{
  const fake = new FakeInbox();
  fake.items = [item("o", "alice")];
  const turn = new InboxTurn(fake);
  assert(turn.start()?.id === "o", "origin = o");
  // simulate overflow: the front (origin) is force-acked + evicted, a newer message arrives
  fake.items.shift();
  fake.items.push(item("new", "bob"));
  turn.commit();
  assert(fake.acked.length === 0, "commit after eviction does not mis-ack the newer front");
  assert(ids(fake.items) === "new" && !turn.inFlight, "newer item left intact; turn idle");
}

console.log("INBOX-TURN SMOKE OK ✅");
