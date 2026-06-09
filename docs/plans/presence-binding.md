# Plan: bind presence cards to their writer's identity

## Problem

Presence is a JetStream KV bucket. Each peer writes one key — its own id — and the
server's publish ACL scopes every agent to `$KV.<bucket>.<own-id>`, so a peer can only
write **its own** key. That half is sound.

But the *value* under that key is the peer's full `card` (`{ id, name, role }`), and we
never check that the card matches the key. `handleKvEntry` does:

```ts
this.applyPresence(e.key, p);   // roster keyed by e.key, but stores p.card verbatim
```

`e.key` is ACL-bound to the writer. `p.card.name` / `p.card.role` are not. So a peer that
legitimately owns key `U_attacker` can publish a card claiming
`{ id: "U_attacker", name: "linus", role: "reviewer" }` and it lands on everyone's roster
as **linus**. Nothing on the wire contradicts it.

This matters more now that **@mentions are name-based**: mention priority/wake routing keys
off `card.name`. Spoof a name on the roster and you can (a) impersonate a peer in the
god-view/dashboard and (b) influence who gets mention-woken.

## Proposed fix

One assertion at the ingest boundary — drop any presence entry whose card id doesn't equal
the KV key it was written under:

```ts
private handleKvEntry(e: KvEntry): void {
  if (e.operation === "DEL" || e.operation === "PURGE") { this.markOffline(e.key); return; }
  let p: Presence;
  try { p = e.json<Presence>(); } catch { return; }
  if (p.card.id !== e.key) return;   // card not bound to its ACL-scoped key → reject
  this.applyPresence(e.key, p);
}
```

Because the key is ACL-bound and we now require `card.id === key`, `card.id` becomes
trustworthy. `name`/`role` remain self-asserted **but** are now firmly tied to one stable,
non-spoofable id — a peer can pick any name, but cannot wear another peer's id, and two
peers can't collide on one id (they'd collide on the ACL-scoped key first).

## Scope

- `packages/core/src/endpoint.ts` — the one guard above.
- `packages/core/smoke.ts` — add a case: a presence entry whose `card.id` ≠ key is ignored.
- No wire-format change, no new subjects, no API change. Backward compatible (honest peers
  already write `card.id === key`).

## Explicitly out of scope

- Binding `name`/`role` cryptographically (would need signed cards / a naming authority —
  much heavier, not warranted for a coordination mesh where names are conveniences).
- Roster eviction of offline peers (separate concern; tracked elsewhere).

## Questions for review

1. **Is key==id the right trust anchor**, or should we go further and verify the JWT
   subject too? (`e.key` is already ACL-bound to the writer's nkey, so id is as strong as
   auth itself — is anything gained by re-deriving subject?)
2. **Fail-closed vs fail-noisy**: silently `return` on mismatch, or `emit("error")` /
   log it? A spoof attempt is worth surfacing, but a noisy log is a DoS vector.
3. **Name collisions among honest peers** (two agents both named "worker"): out of scope
   here, but does the mention design need a tiebreak, or is "names are advisory" fine?
4. Any reason this belongs at the *server* (ACL/account) layer instead of client-side
   ingest? Client-side protects each reader; server-side would protect the whole space at
   once but needs account-server config.
