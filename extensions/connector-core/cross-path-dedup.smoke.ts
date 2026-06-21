/**
 * Cross-path dedup commit invariant (no broker) — drives MeshAgent.ingest directly via the endpoint
 * "message" event to prove the live/durable transition window cannot drop a durable commit.
 *
 * When the SAME message id arrives on both paths, ingest keeps one inbox entry and must retain an
 * ACKABLE handle: a live copy's no-op ack must NEVER overwrite a durable copy's real ack, in either
 * arrival order. Otherwise drainInbox "acks" via the no-op, the durable copy is never committed,
 * JetStream redelivers it after ack_wait, and it double-surfaces — the exact regression the
 * coverage-partition can't close in the transition window.
 *
 * Run: pnpm smoke:cross-path-dedup   (pure in-process — no nats-server needed)
 */
import { strict as assert } from "node:assert";
import type { CotalMessage, Delivery, MessageMeta } from "@cotal-ai/core";
import { MeshAgent } from "./src/agent.js";
import type { AgentConfig } from "./src/config.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space: "dedupsmoke",
  name: "Otto",
  role: "generalist",
  servers: "nats://127.0.0.1:1", // never connected — we only drive the "message" event
  subscribe: ["ch"],
  allowSubscribe: ["ch"],
  allowPublish: ["ch"],
  kind: "agent",
  tls: false,
  id: "otto_agent",
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});

const meta: MessageMeta = { historical: false, kind: "channel" };
const msg = (id: string): CotalMessage => ({
  id,
  ts: 1,
  space: cfg.space,
  from: { id: "peer", name: "Peer", kind: "agent" },
  channel: "ch",
  parts: [{ kind: "text", text: "hi" }],
});
// Counting deliveries: each ack bumps its own counter, so after drainInbox we can see exactly WHICH
// handle was committed (the live one mirrors the endpoint's no-op, but we count it to prove it was NOT
// the retained handle).
const mkDelivery = (durable: boolean, c: { n: number }): Delivery => ({ ack: () => c.n++, nak: () => {}, durable });

try {
  // ── Case 1 — durable FIRST, live SECOND (the trap): the late live no-op must not clobber the ack ──
  {
    const dc = { n: 0 };
    const lc = { n: 0 };
    agent.ep.emit("message", msg("m1"), mkDelivery(true, dc), meta);
    agent.ep.emit("message", msg("m1"), mkDelivery(false, lc), meta); // same id, live second
    check("durable-first/live-second: single inbox entry (no double-surface)", agent.inboxCount() === 1);
    const items = agent.drainInbox();
    check("durable-first/live-second: exactly one surfaced", items.length === 1);
    check("durable-first/live-second: the DURABLE ack committed, the live no-op did NOT overwrite it", dc.n === 1 && lc.n === 0, { dc, lc });
  }

  // ── Case 2 — live FIRST, durable SECOND: the durable copy must UPGRADE the retained handle ──
  {
    const dc = { n: 0 };
    const lc = { n: 0 };
    agent.ep.emit("message", msg("m2"), mkDelivery(false, lc), meta);
    agent.ep.emit("message", msg("m2"), mkDelivery(true, dc), meta); // durable second
    check("live-first/durable-second: single inbox entry", agent.inboxCount() === 1);
    agent.drainInbox();
    check("live-first/durable-second: the DURABLE ack committed (upgraded from the live no-op)", dc.n === 1 && lc.n === 0, { dc, lc });
  }

  // ── Case 3 — durable redelivery (same path, both durable): take the FRESHEST handle ──
  {
    const first = { n: 0 };
    const second = { n: 0 };
    agent.ep.emit("message", msg("m3"), mkDelivery(true, first), meta);
    agent.ep.emit("message", msg("m3"), mkDelivery(true, second), meta); // redelivery, fresh handle
    check("durable redelivery: single inbox entry", agent.inboxCount() === 1);
    agent.drainInbox();
    check("durable redelivery: the FRESHEST durable handle is committed", second.n === 1 && first.n === 0, { first, second });
  }

  // ── Case 4 — two live copies (both no-op): still dedups to one surface ──
  {
    agent.ep.emit("message", msg("m4"), mkDelivery(false, { n: 0 }), meta);
    agent.ep.emit("message", msg("m4"), mkDelivery(false, { n: 0 }), meta);
    check("two live copies: single inbox entry (deduped)", agent.inboxCount() === 1);
    const items = agent.drainInbox();
    check("two live copies: exactly one surfaced", items.length === 1);
  }

  // ── Case 5 — live FIRST, DRAINED/surfaced, durable SECOND (the post-drain trap) ──
  // The first copy is already handled and removed from the inbox when the durable copy arrives, so the
  // pending-inbox check alone wouldn't catch it. It must NOT re-surface, and the durable copy must be
  // COMMITTED (its logical message was already handled) so JetStream stops redelivering.
  {
    const lc = { n: 0 };
    const dc = { n: 0 };
    agent.ep.emit("message", msg("m5"), mkDelivery(false, lc), meta);
    check("live-first/drain: surfaced on first drain", agent.drainInbox().length === 1);
    agent.ep.emit("message", msg("m5"), mkDelivery(true, dc), meta); // durable copy AFTER the drain
    check("live-first/drain/durable-second: durable duplicate does NOT re-buffer", agent.inboxCount() === 0);
    check("live-first/drain/durable-second: nothing re-surfaces", agent.drainInbox().length === 0);
    check("live-first/drain/durable-second: the durable duplicate is COMMITTED (acked, not lost)", dc.n === 1, { dc });
  }

  // ── Case 6 — durable FIRST, DRAINED/surfaced, live SECOND: live duplicate drops, no re-surface ──
  {
    const dc = { n: 0 };
    const lc = { n: 0 };
    agent.ep.emit("message", msg("m6"), mkDelivery(true, dc), meta);
    agent.drainInbox(); // surfaces + commits the durable copy (dc.n → 1)
    agent.ep.emit("message", msg("m6"), mkDelivery(false, lc), meta); // live copy AFTER the drain
    check("durable-first/drain/live-second: live duplicate does NOT re-buffer", agent.inboxCount() === 0);
    check("durable-first/drain/live-second: nothing re-surfaces", agent.drainInbox().length === 0);
    check("durable-first/drain/live-second: durable committed once, live no-op added nothing", dc.n === 1 && lc.n === 0, { dc, lc });
  }

  console.log(`\nCROSS-PATH DEDUP SMOKE OK ✅  (${pass} passed, 0 failed)`);
  process.exit(0);
} catch (e) {
  console.error(`\nCROSS-PATH DEDUP SMOKE FAILED ❌  ${(e as Error).message}`);
  process.exit(1);
}
