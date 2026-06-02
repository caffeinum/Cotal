# Swarl — Working Overview (v0.1 draft)

> Living draft — *what* Swarl should be able to do, not how it's built. Open questions
> are at the end; implementation and research detail live in [architecture.md](architecture.md).

## What Swarl is

A standard interface for software — especially AI agents — to coordinate in real time
as **lateral peers in a shared space**, instead of as nodes in an orchestrator tree.
Participants join a shared pub/sub space, keep presence, broadcast to the group or
message one peer directly, see what others are doing, and coordinate as peers.

The base unit is the **endpoint** — any software on the network. An **agent node** is
an endpoint with identity, role, and capabilities.

Transport is **NATS + JetStream** (local demo first; the same design scales to a
cluster later). Reference implementation is **TypeScript**.

## Principles

- **The wire contract is the standard.** The subjects, message schemas, and
  presence/discovery conventions *are* Swarl; libraries are thin clients over them.
- **Primitives, not a prescribed topology.** Squad-of-peers, orchestrator-and-workers,
  or any hybrid are configurations on top — never baked in.
- **One command to join.** Integration ease is the moat.
- **Lateral and long-running.** Peers hold long-lived connections and talk directly.
- **Local-first, no-rewrite scaling.** The same subjects, streams, and accounts run
  unchanged from one machine to a cluster.

## Core primitives

| Primitive | What it is |
|---|---|
| **Endpoint** | Any software on the mesh: long-lived connection, own presence, subscribes to channels, buffers inbound. |
| **Agent node** | An endpoint with identity, role, and capabilities (an A2A-style AgentCard). |
| **Space** | A collaboration, isolated from other spaces. |
| **Channel** | A named topic participants broadcast on and subscribe to. |
| **Direct message** | A message addressed to one peer. |
| **Presence & discovery** | Live roster of who's present, with state (`idle` / `waiting` / `working` / `offline`) and each peer's AgentCard. |
| **History** | Recent messages a late joiner can replay. |

## What it should be able to do

Four core capabilities, plus observability, history, and isolation.

- **Addressability** — three delivery modes (SLIM-inspired): **multicast** (broadcast to
  a channel), **unicast** (message one peer), and **anycast** (reach *any one* of a role —
  "whoever is a reviewer"); many participants per channel.
- **Control plane** — a separate command path to *act on* endpoints: ask status, send
  a directive, set role, pause/resume — with replies.
- **Data sharing** — two directions:
  - *Outbound:* **ambient** (lifecycle activity streams to the mesh automatically) and
    **deliberate** (an agent publishes a message on purpose).
  - *Inbound:* **pull** (the agent reads its buffer when it chooses) and **push** (a
    message is delivered into the live session — soft between turns, or urgent/
    interrupting). A buffer/policy sits in front, so traffic is queued or coalesced,
    never piped in raw; ambient traces reach the mesh but not every agent's attention.
- **Coordination** — agents announce intent and watch peers' presence/activity, then
  divide work and delegate over channels and DMs. They share one workspace with **no
  isolation** (no worktrees), staying out of each other's way by coordinating.
- **Observability** — traces and presence are on the mesh, so a dashboard can be built
  later; the first demo needs none (the user just watches the terminals).
- **History & late join** — a late participant replays recent messages and the current
  roster, then goes live.
- **Isolation** — spaces don't see each other; many can run on one machine.

## The first demo

Role-specialized agents (Claude Code + Codex) join one shared space, each in its own
terminal, and coordinate laterally — presence, addressing, messaging, and a control
plane — configurable, not hardwired (the *topology* is how you set it up, not baked in).

Full scenario and run steps: **[DEMO.md](DEMO.md)**.

## Decided so far

- **Stack** — TypeScript, pnpm monorepo (`@swarl/core`, `@swarl/cli`), NATS + JetStream.
- **Wire shapes** — A2A-inspired `AgentCard` + `Message`/`Part`; **SLIM-inspired** addressing
  (`space / service / instance`) and the three delivery modes. See [architecture.md](architecture.md).
- **Presence states** — `idle` / `waiting` / `working` / `offline`.
- **Built so far** — `@swarl/core` endpoint (presence, multicast, unicast) + `@swarl/cli`
  (`up` / `join` / `watch`), smoke-tested end-to-end.

## Open questions

- **Hosting mode** — agents in their own native terminals (Swarl attaches via hooks +
  MCP; lighter, but limited inbound push for Codex) vs. `swarl run` hosting the session
  (full push + interrupt). Keystone: it sets how much inbound push is possible.
  *Leaning attach-first for the demo.*
- **Inbound buffer/policy** — defaults for queue vs coalesce vs immediate injection.
- **Control-plane commands** — which ship first.
- **Coordination primitives** — advisory intent records / leases: in or out, what shape.
- **Topology configuration** — how a user declares roles and collaboration patterns.
