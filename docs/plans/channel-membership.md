# Plan: make channel membership observable (who is on which multicast channel)

## Problem

You can ask "which channels **exist**" (`listChannels()` scans the CHAT stream's subject
state for channels that have messages), but you cannot ask "**who is listening** to
`#review`?" An observer can see channels and peers, but never the edges between them.

## Source of truth: the broker, not self-report

Channel membership must be **server-known**, not self-asserted. We don't add a `channels`
field to presence — a peer could lie about it (claim coverage it isn't providing) or omit
it to lurk. Instead we read it from where the server already records it.

In Cotal a peer joins a channel by creating a **JetStream durable consumer** on the CHAT
stream — `durable_name = chat_<id>`, `filter_subjects` = its channels (`endpoint.ts:582`).
So `consumers.list(CHAT_<space>)` *already* yields the real membership: the id (from the
durable name) and the channels (from `filter_subjects`). Authoritative, can't be forged,
no wire-format change.

This closes the lurk hole for the agent class by construction: an agent's `sub.allow` is
`[_INBOX_<id>.>]` only (`provision.ts:268`) — it has no core-NATS subscribe grant on
`chat.*`, so its **only** path to a channel is the durable consumer, which the broker
records. (The privileged observer/admin profiles read `chat.>` via core NATS and leave no
durable — they are an intentional, named exception; see "Not all listeners" below.)

## Membership = broker truth ∩ presence liveness

A durable consumer **existing** is not the same as a peer **listening now**. Durables
deliberately survive disconnects (the chat durable's `inactive_threshold` is ~10 min — load-bearing
reconnect grace: a reconnecting peer rebinds the same `chat_<id>` and resumes from its
ack-floor, no replay). Our operational reality is "absent usually = an MCP reconnect". So
`consumers.list` over-counts the dead/reconnecting for up to ~10 min.

Presence is the reliable liveness signal. So **join the two**:

- `consumer ∩ presence-online` → **live member**
- `consumer ∩ presence-offline / absent` → **stale ghost** (gone, durable lingering)
- `presence − consumer` → foreign / odd

Presence also carries the graceful-leave event: `stop()` publishes `status="offline"`
explicitly (`endpoint.ts:228`) before draining; a crash never does (its presence just
TTL-expires into absence). A live observer renders "alice left #review" off that offline
flip.

**Posture (the premise the zero-grant design rests on):** membership is a *live view*.
Leave-vs-crash is observable as an **event** (the offline flip, ~6s before the presence
record purges), not reconstructable from a **cold snapshot** — a freshly-opened `watch`
reads "gone" for both a polite leaver and a crasher. That is correct behavior for Demo 1
(the demo dashboard is always-on and catches the event), and a known gap for a future
persistent/audit surface (see follow-ups).

## Served dashboard-only

The membership view is served **only from the privileged read surfaces**
(`watch` / `console` / `manager`), which already subscribe `chat.>` and can list consumers
(`provision.ts:183-199`). **No new agent grant.** `cotal_roster` stays presence-only
("who exists / who's alive" — what an agent legitimately needs for addressing and
mention-validation).

This is least-privilege *and* correct interaction design: the only thing an agent could do
with a "who's on #review" readout is gate its send on it — which is forbidden (it breaks
pub/sub decoupling) and unsound (membership lags reality). Withholding the capability is a
stronger guardrail than naming a convention: an agent can't gate on a query it structurally
cannot make.

### Not all listeners

The view shows **declared JetStream members**, not every reader: the privileged
observer/admin profiles tap `chat.>` via core NATS / ephemeral consumers and leave no
durable footprint, so they don't appear. That's a fixed, by-design, trusted class — not an
open lurker hole (agents can't core-sub). Caption the surface with the honest noun —
e.g. **"N declared · M live · K stale"** — plus one footnote that privileged audit profiles
aren't enumerated. Don't put secrets in channel names: membership edges and channel names
are visible to everyone with stream-read on the space.

## Scope (Demo 1)

- `packages/core/src/endpoint.ts` — one function that calls `consumers.list(chatStream)` and
  parses each consumer into `{ id, channels }`, living next to where the chat consumer is
  created (so the JetStream-internal coupling — "membership == durable consumers" — is
  contained to the one file that owns the layout and changes with it). Surfaces never call
  `consumers.list` themselves.
  - Recover channels via `parseSubject` over `filter_subjects` (not string-splitting). The
    broker returns the **collapsed** filter (`team.>`, not `team.> + team.backend`) — the
    *effective* subscription, which is what "who receives on X" wants.
  - Recover the id by stripping `chat_` and matching forward against `token(p.card.id)` over
    the live roster (don't reverse the lossy durable name). A consumer with no roster match
    is a ghost/foreign id — display the id prefix, never drop it.
  - **Coordinate with the channel-registry plan** (`channel-registry.md`): if per-channel
    replay control lands, each endpoint's durable splits into `chat_<id>` (replay) +
    `chatnew_<id>` (no-replay). The parser must then **union both prefixes per id** —
    `channels = filter_subjects(chat_<id>) ∪ filter_subjects(chatnew_<id>)` — so a no-replay
    subscriber stays visible. Membership is indifferent to *how* a peer receives; the two
    must land together.
  - `consumers.list` is a JSAPI round-trip (the presence-only view was free); cache / refresh
    on a sane interval, don't poll it per render frame.
- Surfaces (`watch` / `console` / `manager`) — join the consumer list with the roster and
  render live / stale / foreign with the caption above.
- Docs: `architecture.md` (presence + channels), `claude-code-integration.md`.

No new NATS grant for Demo 1.

## Deferred follow-ups (captured, not built)

- **Self-delete-on-leave** — to make a *cold-snapshot* view distinguish a polite leaver from
  a crasher, the leaver's durable must be deleted (`chat_<id>` gone = left; lingering =
  crashed). This requires (1) **expressing leave intent**, and (2) a self-scoped
  `CONSUMER.DELETE.CHAT.chat_<ownId>` grant (concrete name only — never a wildcard, which
  would also match other peers' durables → a channel-kick / DoS). Worth it only once a
  persistent/audit membership surface exists.

  The hard part is (1), and it's a **protocol decision, not a `stop()` boolean**. Today
  `stop()` is a single intent-free teardown path (`endpoint.ts:214-239`) — and a standalone
  peer is torn down by a signal (SIGINT/SIGTERM) that carries no intent, so a dying process
  can't tell "retire me" from "restart me in 5s". Deleting on `stop()` would break
  reconnect-grace (a fresh durable re-replays the whole window under `DeliverPolicy.All`).
  So the real fork is: **an explicit leave verb at the surface** (the peer self-classifies
  and self-deletes — keeps delete rare/self-scoped) **vs the manager deleting on
  permanent-stop** (it holds the intent for managed peers, but makes "manager deletes a
  peer's chat durable" a routine op, eroding the audit boundary below). Price it as a
  protocol addition.
- **Revocation GC** — when credential revocation lands (deferred; creds have no TTL today),
  cutting a peer must **also** delete its `chat_<id>` (+ `dm_<id>` + svc) durables. There
  this is **access control**, not hygiene (a left-in-place durable keeps retaining traffic
  for a revoked principal), so it's non-deferrable on the revoke path and runs on the
  **privileged** actor (manager, allow-all) — never the kicked peer, which won't cooperate.
  **Order is non-negotiable: invalidate creds first, then delete the footprint.** The agent
  holds self-CREATE on its own durable (`provision.ts:232`), so deleting `chat_<id>` while
  its creds are still valid is theater — it just re-creates the durable and resumes. Delete
  is the second half of a two-step that's worthless without the cred-kill first.

These two cleanup paths are mapped by actor intent — cooperative exit → self-delete;
adversarial removal → privileged GC — and are complementary, not alternatives.

## Out of scope

- Channel-level access control (who may *join* a channel). This is observability only.
- Dynamic join/leave of channels (channels are fixed at init today).
- Server monitoring (`/connz`, `/subsz`) for full subscriber enumeration — that's an
  ops/admin trust boundary mesh agents shouldn't be granted; `consumers.list` is the right
  native, in-band signal.
