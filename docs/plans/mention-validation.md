# Plan: how should @mention validation behave on an unknown name?

## Context

Channel messages now carry `mentions: string[]` — a priority/wake hint. If you're
mentioned, you're woken now; if not, ambient chatter waits for your next idle moment. The
open decision: **what happens when someone @mentions a name that isn't on the wire?**

```ts
await agent.send("ship it @lina", { channel: "review", mentions: ["lina"] });
// ...but no peer named "lina" is present. Now what?
```

## Two candidate behaviors

**A — Throw (strict).** Validate every mention against the live roster; reject the whole
send if any name is unknown. The sender gets an immediate error and fixes the typo.

```ts
const known = new Set(this.ep.getRoster().map((p) => p.card.name.toLowerCase()));
const unknown = mentions.filter((m) => !known.has(m));
if (unknown.length) throw new Error(`unknown mention: @${unknown.join(", @")} — no such peer in "${space}"`);
```

**B — Warn-and-send (lenient).** Send the message anyway; drop the unknown name from the
priority set (it just won't wake anyone) and optionally note it. Nothing blocks.

## The tradeoff (this is the debate)

| | Throw (A) | Warn-and-send (B) |
|---|---|---|
| Typos | caught instantly | silently do nothing |
| Late join | mention before peer arrives → **fails** | mention "lands" when they show up?† |
| Failure mode | loud, local | quiet, easy to miss |
| Race | roster is eventually-consistent — a present peer can look absent for ~a heartbeat → **false throw** | tolerant of the race |
| Mental model | "mentions address present peers" | "mentions are best-effort hints" |

† only if we also persist/replay mentions — which we currently don't.

## Current state

We shipped **A (throw)**. This plan asks the reviewers to stress-test that call before we
commit to it as the protocol's contract.

## Questions for review

1. **Is a hard throw right for a priority *hint*?** Mentions don't route (the channel
   delivers to everyone regardless) — they only affect wake priority. Should a non-routing
   hint ever *block* a send?
2. **The roster race.** Presence is eventually-consistent over a KV watch. A peer present
   "right now" can be absent in my local roster for up to a heartbeat. Does throw turn a
   real, valid mention into a spurious failure? Is that acceptable?
3. **Late join / out-of-order.** If you mention someone milliseconds before they join, throw
   loses the message entirely. Is that the wrong default for a mesh built around late join?
4. **Where's the floor?** If we keep throw, should validation live client-side (each sender)
   or be advisory only, with no protocol-level guarantee at all?

## Scope (either way)

- `extensions/connector-core/src/agent.ts` — `assertKnownMentions` (already present for A).
- `extensions/connector-core/src/tools.ts` — `cotal_send` mention param + error surfacing.
- Docs: `architecture.md`, `claude-code-integration.md`.
- No wire-format change; `mentions[]` is already on `CotalMessage`.
