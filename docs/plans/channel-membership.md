# Plan: make channel membership observable (who is on which multicast channel)

## Problem

You can ask "which channels **exist**" (`listChannels()` scans the CHAT stream's subject
state for channels that have messages), but you cannot ask "**who is listening** to
`#review`?" A channel join is just a NATS/JetStream subscription, and NATS deliberately
never tells anyone who is subscribed — subscribers are invisible to publishers by design.

So an agent about to multicast has no way to reason about reach ("will anyone even see this
if I post to `#review`?"), and the `watch`/`console` observability views can show *channels*
and *peers* but never the edges between them.

The one party that *does* know a peer's channels is the peer itself — it passed them at
init (`endpoint.ts:580-593`, the chat consumer's `filter_subjects`). The fix is to have
each peer **self-report** that membership, not to probe the broker.

## Proposed design

Channel membership is dynamic per-endpoint state, so it rides on **presence**, not on the
identity `AgentCard`. Add one field to `Presence`:

```ts
export interface Presence {
  card: AgentCard;
  status: PresenceStatus;
  activity?: string;
  /** Channel patterns this peer is subscribed to (as declared at subscribe time, incl.
   *  wildcards like "team.>"). Self-reported; advisory, like name/role. Omitted = unknown. */
  channels?: string[];
  ts: number;
}
```

Why presence and not the card:
- Presence is rewritten every heartbeat, so reporting channels is free, and *updating* it
  on a future dynamic join/leave is just the next heartbeat — no new machinery.
- An endpoint that goes offline correctly drops out of every channel view at once (TTL
  expiry), with no separate cleanup.
- The card is stable identity (`id`/`name`/`role`); channels change. Keeping them apart
  keeps the card honest.

Membership then becomes a **pure derived view over the roster we already watch** — no new
subjects, no new KV bucket, no registry to keep in sync:

```ts
// core endpoint
channelMembers(channel: string): Presence[] {
  return this.getRoster().filter(
    (p) => p.status !== "offline" && (p.channels ?? []).some((pat) => subjectMatch(pat, channel)),
  );
}
```

### The one subtlety: wildcards

Peers subscribe to *patterns* (`team.>`, not just `team.backend`). So `presence.channels`
stores the declared patterns, and the "who's on `X`" query must match `X` against each
peer's patterns with NATS token semantics (`*` = one token, `>` = tail). That match lives
in one shared helper (`subjectMatch`) reused by the query above. Storing patterns (not
expanded concrete channels) is what keeps this correct for hierarchical channels.

## Scope

- `packages/core/src/types.ts` — add `channels?: string[]` to `Presence`.
- `packages/core/src/endpoint.ts` — populate `channels` when publishing presence; add
  `channelMembers(channel)`; expose channels on roster entries. Add `subjectMatch` (or
  reuse the existing wildcard logic behind `collapseFilterSubjects`).
- `packages/core/smoke.ts` — case: two peers on overlapping channels; assert
  `channelMembers` resolves the right set, incl. a wildcard subscriber.
- Surfaces: `cotal_roster` (MCP) and `cli watch`/`console` show channels-per-peer /
  members-per-channel.
- Docs: `architecture.md` (presence section), `claude-code-integration.md`.

No wire-format break: `channels?` is optional; older/honest peers that omit it simply show
as "channels unknown", not "on no channels".

## Explicitly out of scope

- **Access control** — who is *allowed* to join a channel. This is observability only.
- **Dynamic join/leave** — the schema supports it (just re-report on change), but channels
  are static-at-init today and we are not adding subscribe/unsubscribe here.
- **Broker-truth membership** — deriving members from actual JetStream durable consumers.
  Consumers are durable and can outlive a dead peer, so they would report ghosts; the
  self-reported, TTL-expiring presence view is the more honest one.
- **Cryptographic binding** of the claimed channel set (same posture as name/role: advisory;
  see [presence-binding.md](presence-binding.md) — `card.id` is the only hardened field).

## Questions for review

1. **Presence vs card.** Channels-as-dynamic-state argues presence. Is anyone uncomfortable
   that an endpoint's "where it listens" lives in the same record as its volatile
   status/activity rather than its identity?
2. **Self-reported = advisory.** A peer can claim a channel it isn't really on, or omit one
   it is. For a coordination mesh that seems fine (same trust level as `name`/`role`). Is
   advisory membership acceptable, or does any use case need broker-truth?
3. **Does exposing listeners invite anti-patterns?** Multicast is fire-and-forget; making
   "who's listening" queryable could tempt senders to gate on receivers (defeating the
   decoupling). Is the observability win worth that risk, and should the API frame it as
   "for humans/dashboards" vs "for routing decisions"?
4. **One unified channel view?** Should `listChannels()` merge *channels with messages* and
   *channels with live members* into a single list (a channel can have members but no
   messages yet, or messages but no current members)?
5. **Eventual consistency.** Membership is only as fresh as the presence TTL (~6s) and can
   lag a real join by a heartbeat. Fine for a hint/observability; any caller that would
   treat it as authoritative is the bug — agreed?
