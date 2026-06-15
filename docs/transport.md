# Cotal — Transport bindings & the capability contract

> What in Cotal is the *protocol* and what is the *transport*, and the contract any transport
> binding has to satisfy. Proposal, not locked. Companion to the
> [NATS/JetStream mapping](architecture.md#technical-mapping-nats--jetstream).

Cotal runs on NATS/JetStream today, and that is the *reference binding*, not the definition.
This page draws the line so "transport-agnostic" is a checkable claim rather than a slogan. We
do **not** add a transport abstraction layer in code yet — there is no second consumer — the
decoupling here is at the spec level.

## The two layers

- **The Cotal protocol** (transport-agnostic): the wire contract. The message shapes
  ([`types.ts`](../packages/core/src/types.ts), already marked "transport-agnostic"), the
  addressing model (hierarchical `space / service / instance`, three delivery modes), and the
  coordination semantics (spaces, channels, presence, history/replay, discovery, and
  *authenticated directedness* — sender and message-class derive from the delivery channel, not
  the payload). **This is the standard.**
- **A transport binding**: realizes that contract on a concrete substrate. NATS/JetStream is the
  reference binding; [`subjects.ts`](../packages/core/src/subjects.ts) is its NATS encoding.

The lateral-peer coordination model is the value and lives entirely in the first layer. The
transport is an implementation detail underneath it.

## The transport capability contract

A conforming binding must provide each capability — or Cotal must supply it on top of the
transport. There are five.

| # | Capability | What it means |
|---|---|---|
| 1 | **Addressed routing** | Hierarchical names with wildcards; the three delivery modes — multicast (a channel + its subtree), unicast (one instance), anycast (one-of-N for a role, load-balanced). Sender **and** delivery-class must be attributable to the delivering channel, not the payload (the authenticity primitive). |
| 2 | **Durable delivery & history** | Per-recipient bookmarks, store-and-forward so an offline / mid-turn agent misses nothing, explicit ack + redelivery, and bounded late-join replay. |
| 3 | **Presence & registry state** | A small per-space key/value store (TTL/expiry) for presence (`idle`/`waiting`/`working`/`offline`) and channel config. |
| 4 | **Identity** | A stable per-agent id the transport can bind delivery and authenticity to. |
| 5 | **Authorization & isolation** | A per-space boundary: an agent emits only as itself, only to its declared channels, reads only its own DMs; cross-space isolation. |

Capabilities 1, 4, 5 are *transport-shaped* (routing, identity, authz are properties of the
pipe). Capabilities 2 and 3 are *state* — a transport that is purely a live pipe does not have
them, and then they become Cotal's job.

## NATS reference binding

NATS/JetStream satisfies all five natively, which is why Cotal is batteries-included today:

| Capability | NATS realization |
|---|---|
| Routing | Subjects `cotal.<space>.{chat\|inst\|svc\|ctl}.<sender|route>.…`; sender encoded in the subject (`parseSubject` is the sole authority); `*`/`>` wildcards; queue groups for anycast. |
| Durability & history | JetStream streams `CHAT_/DM_/TASK_<space>`, per-reader durable consumers (`chat_/dm_/svc_`), ack-on-surface, Direct-Get backfill for late join. |
| Presence & registry | KV buckets `cotal_presence_<space>` and `cotal_channels_<space>`. |
| Identity | The agent's **nkey public key** = `card.id` = subject sender token = JWT subject = durable name ([`identity.ts`](../packages/core/src/identity.ts)). |
| Authz & isolation | Operator-signed **account per space** + per-profile JWT ACLs (agent/observer/admin/manager) built from the shared subject/stream builders ([`provision.ts`](../packages/core/src/provision.ts)). |

Capabilities 2 and 3 are *offloaded to JetStream and KV* — Cotal does not implement history,
presence, or exactly-once itself, it leans on the substrate (per the "use native NATS features,
don't re-implement" rule). That is what makes NATS such a strong reference binding.

## Binding to another transport

The contract is what a second binding implements against. The thing to watch: routing,
identity, and authz (1, 4, 5) are properties most transports can offer, but **durability and
presence (2, 3) are state, and a live-only transport does not have them.** On any transport
without native store-and-forward and a presence/registry store, Cotal has to supply both layers
itself. So decoupling is never "swap the pipe" — it is "re-supply the state that JetStream and
KV give us for free." Budget for that before adopting any non-NATS substrate.

## What this means

- The decouplable substance is real and it is the protocol layer (types + addressing +
  coordination semantics). Owning it is what makes Cotal the coordination *standard* rather than
  one app on one broker.
- Keep NATS as the reference binding and **do not** build a pluggable transport interface in code
  until a second binding has a consumer. The contract above *is* the decoupling for now.
- Any "transport-agnostic" claim must name capabilities 2 and 3 as transport-provided today (not
  Cotal-implemented), so the claim stays checkable.
