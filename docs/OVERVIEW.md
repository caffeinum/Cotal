# Cotal — Working Overview (v0.1 draft)

> Living draft — *what* Cotal should be able to do, not how it's built. Open questions
> are at the end; implementation and research detail live in [architecture.md](architecture.md).

## What Cotal is

A standard interface for software — especially AI agents — to coordinate in real time
as **lateral peers in a shared space**, instead of as nodes in an orchestrator tree.
Participants join a shared pub/sub space, keep presence, broadcast to the group or
message one peer directly, see what others are doing, and coordinate as peers.

The base unit is the **endpoint** — any software on the network. An **agent node** is
an endpoint with identity, role, and tags.

Transport is **NATS + JetStream** (local demo first; the same design scales to a
cluster later). Reference implementation is **TypeScript**.

## Principles

- **The wire contract is the standard.** The subjects, message schemas, and
  presence/discovery conventions *are* Cotal; libraries are thin clients over them.
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
| **Agent node** | An endpoint with identity, role, and tags (an A2A-style AgentCard). |
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
- **Observability** — traces and presence are on the mesh, so any observer can render
  them: `cotal console` (terminal) or `cotal web` (browser dashboard — presence, channels,
  live feed; see [web.md](web.md)).
- **History & late join** — a late participant replays recent messages and the current
  roster, then goes live.
- **Isolation** — spaces don't see each other; many can run on one machine.

## The first demo

Role-specialized agents (Claude Code + Codex) join one shared space, each in its own
terminal, and coordinate laterally — presence, addressing, messaging, and a control
plane — configurable, not hardwired (the *topology* is how you set it up, not baked in).

Full scenario and run steps: **[examples/01-lateral-coordination](../examples/01-lateral-coordination/README.md)**.

## Decided so far

- **Stack** — TypeScript, pnpm monorepo (`@cotal-ai/core`, `@cotal-ai/cli`), NATS + JetStream.
- **Wire shapes** — A2A-inspired `AgentCard` + `Message`/`Part`; **SLIM-inspired** addressing
  (`space / service / instance`) and the three delivery modes. See [architecture.md](architecture.md).
- **Presence states** — `idle` / `waiting` / `working` / `offline`.
- **Built so far** — `@cotal-ai/core` endpoint (presence + all three delivery modes:
  multicast / unicast / anycast) + `@cotal-ai/cli` (`up` / `join` / `watch`), smoke-tested.
- **Manager (supervisor)** — a long-lived **node** that owns agent *lifecycle + config*
  (not their work); CLI/dashboard drive it over the **control plane**
  (`start`/`stop`/`ps`/`status`/`bind`). Supervisor-only (agents self-connect; manager off the
  message hot path); demo spawns native agent TUIs in terminal panes.
- **Claude Code integration (demo)** — **attach mode**: one Cotal **plugin** = a
  dual-purpose MCP server (channel push + `cotal_send`/`cotal_dm`/`cotal_anycast` + `cotal_inbox`) plus `http`
  lifecycle hooks for presence/ambient. Deterministic **hook** injection is the spine; the
  **channel** adds async "wake when idle/away." Onboarding is **pure native** —
  `/plugin install` then launch the real `claude` with the plugin (space identity via env,
  auto-join); no wrapper binary. Host mode (Agent SDK, true mid-turn interrupt) is the
  documented upgrade path. Limits accepted:
  no mid-turn interrupt in attach mode, channel push is research-preview-gated. Detail in
  [architecture.md](architecture.md).
- **Roles** — a role is a reusable `<role>.md` template (YAML frontmatter + optional persona
  body) producing an A2A `AgentCard`: `role` = the addressable **service** (anycast),
  advertisement (`description` + `skills`/`tags`), optional persona, and runtime defaults
  (channels, inbound policy). Resolved by the plugin from `COTAL_ROLE`; managed with
  `cotal role new/list/show`. **Persona-optional** (primitives, not prescribed personas).
- **Identity & authorization (on by default; `cotal up --open` to disable)** — the mesh is a
  real boundary against untrusted peers in a shared space: the **sender is encoded in the subject** (server-
  policed, not self-asserted), so an agent can only emit **as itself**; per-agent JWT ACLs scope
  publishing to its **declared channels**; and DMs are confidential on both leak paths (scoped
  per-identity inbox + provisioner-pre-created bind-only durables). Account = space, user =
  agent, minted by a **provisioner** (the signer capability, not manager-special). Open mode
  stays the default. Full model + limitations in [architecture.md](architecture.md).

## Open questions

- **Inbound buffer/policy** — defaults for queue vs coalesce vs immediate injection.
- **Control-plane commands** — manager ops (`start`/`stop`/`ps`/`status`/`bind`) are the first
  cut; still open is the agent-directed set (directive, set-role, pause/resume).
- **Coordination primitives** — advisory intent records / leases: in or out, what shape.
- **Collaboration patterns** — roles themselves are now defined (`.cotal/roles/<role>.md`);
  still open is how a user declares the *patterns between* them (who delegates to whom, leases).
