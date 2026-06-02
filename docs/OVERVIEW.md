 # Swarl — Working Overview (v0.1 draft)

> Status: living draft. Capabilities described here are the target. Anything marked
> **[decision]** is open and yours to weigh in on — nothing in this doc is locked.

## What Swarl is

A standard interface for how software — especially AI agents — coordinates and
collaborates in real time, as **lateral peers in a shared space** rather than as
nodes in an orchestrator tree. Participants join a shared pub/sub space, maintain
presence, broadcast to the group or address a single peer directly, see what others
are doing, and coordinate and delegate as peers.

The base unit is the **endpoint**: any piece of software on the network. An **agent
node** is an endpoint with identity, role, and capabilities that participates in
agent-level coordination.

The transport is **NATS + JetStream** (local single-machine demo first; the same
design scales to distributed cloud with no rewrite). The reference implementation is
**TypeScript**.

---

## First principles

1. **The wire contract is the standard.** The subjects, message schemas, and
   presence/discovery conventions *are* Swarl. Libraries are thin clients over that
   contract — which is what keeps "join in one command" real and keeps us
   interoperable rather than siloed.
2. **Primitives, not a prescribed topology.** Swarl ships addressability, a control
   plane, presence, and data-sharing. Squad-of-peers, orchestrator-and-workers, or
   any hybrid are *configurations on top* — never baked in.
3. **One command to join.** Adding any software to a collaboration should be ~one
   command. Integration ease is the moat.
4. **Lateral and long-running.** Peers hold long-lived connections and talk to each
   other directly, not just up/down a hierarchy.
5. **Local-first, no-rewrite scaling.** Runs on one machine today; the same subjects,
   streams, and accounts run unchanged in a cluster later.

---

## Core primitives

| Primitive | What it is |
|---|---|
| **Endpoint** | Any software on the mesh. Long-lived connection, own presence, subscribes to the channels it cares about, buffers inbound messages. |
| **Agent node** | An endpoint with identity, role, and capabilities (an A2A-style AgentCard). |
| **Space** | A collaboration. Strong isolation boundary (one NATS account per space). |
| **Channel** | A named topic within a space that participants broadcast on and subscribe to. |
| **Direct message** | A message addressed to one specific peer. |
| **Presence** | A live roster of who's in the space, with identity/role and automatic expiry. |
| **Discovery** | The ability to find peers and read their AgentCard (identity, role, capabilities/skills). |
| **History** | Recent activity/messages a late joiner can replay to catch up. |

---

## What the system should be able to do

Organized around the four capabilities that matter most: **addressability,
control plane, data sharing, and coordination** — plus observability, history, and
isolation.

### 1. Addressability
- **Broadcast** to everyone on a channel.
- **Direct-message** a single peer by identity.
- **Address by role or capability** ("whoever is the reviewer", "any endpoint that
  can run tests") — resolved against presence + AgentCards.
- Multiple participants on the same channel at once (true pub/sub, not point-to-point).

### 2. Control plane (commands)
A channel distinct from chat/data, for *acting on* endpoints rather than chatting:
- Query an endpoint's status / current activity.
- Send a directive ("focus on the auth module"), set or change role, pause/resume.
- Request/response semantics (a command can expect a reply).
- **[decision]** the exact command set in scope for demo 1 — see Open Decisions.

### 3. Data sharing — two directions, two modes each

**Outbound (endpoint → mesh):**
- **Automatic / ambient.** Lifecycle activity (the agent's trace) is published to the
  mesh as it happens, so peers — and optionally the user — know what each agent is
  doing. Sourced from each tool's lifecycle hooks; no agent effort required.
- **Deliberate.** The agent calls a tool to publish a message on purpose, to a
  channel or a specific peer.

**Inbound (mesh → endpoint):**
- **Pull.** The agent reads its buffered messages when it chooses (a tool it calls).
- **Push.** A message is delivered *into* the agent's live session. A **buffer/policy**
  sits in front so inbound can be queued, coalesced, or injected immediately — raw
  channel traffic is never piped straight in.
  - *Soft push* (default): delivered between turns, non-interrupting.
  - *Urgent push*: interrupts the current turn. Availability depends on hosting mode
    (see Integration surfaces) — **[decision]**.

> Note on ambient streaming vs. agent attention: ambient traces always flow to the
> *mesh* (for peer awareness and later observability), but they are **not** force-fed
> into every agent's context. What actually reaches an agent's attention is governed
> by its buffer/policy. This keeps "everyone is aware" from becoming "everyone is
> spammed."

### 4. Coordination & delegation
- Agents **announce intent** ("I'm taking the backend") and **observe peers' presence
  and activity**, then coordinate and delegate over channels and DMs.
- Shared workspace, **no isolation required** (no worktrees): agents work in the same
  tree and stay out of each other's way by coordinating.
- **[decision]** optional coordination primitives — e.g. an "I'm editing `foo.ts`"
  intent record, or a lease an agent can claim — could help agents divide work and
  avoid collisions. In or out for demo 1, and what shape? See Open Decisions.

### 5. Observability
- All ambient traces and presence are available on the mesh, so a dashboard *can* be
  built — but **demo 1 needs none**: agents run in their own terminals and the user
  watches those directly. We make sure the data is on the mesh; we don't build the UI
  yet.

### 6. History & late join
- A participant joining late can replay recent channel messages and the current
  presence roster to catch up, then go live — no missed context.

### 7. Isolation
- Spaces are isolated from each other (one NATS account per space). Multiple
  independent collaborations can run on the same machine without crosstalk.

---

## Integration surfaces (Claude Code + Codex)

Both target agents expose the same four surfaces, so a single adapter with two
backends covers them:

| | Claude Code | Codex CLI |
|---|---|---|
| **Outbound — ambient** | Lifecycle hooks → mesh (native `http` hook can POST straight to the local Swarl daemon) | Hooks + `notify`, or `codex exec --json` event stream → mesh |
| **Outbound — deliberate** | MCP tool `swarl_publish` | MCP tool (same) |
| **Inbound — pull** | MCP tool `swarl_inbox` | MCP tool (same) |
| **Inbound — push** | Channels (between-turns) / Agent SDK streaming (true interrupt) | app-server `turn/*` (live) / `resume` (between-turns) |

**Hosting mode is the keystone decision** — it determines how much inbound push is
possible:

- **Attach mode** — agents run in their *own* normal terminals; Swarl attaches via
  hooks + MCP (+ Claude Channels). Lowest friction, feels completely native. Push is
  asymmetric: Claude can receive between-turn pushes via Channels; Codex's plain TUI
  has no clean external-injection path, so Codex peers are **pull-mostly**.
- **Host mode** — `swarl run claude|codex` launches the agent *under* Swarl (Agent
  SDK / app-server) while still presenting a normal-looking interactive terminal.
  Full bidirectional push **and** interrupt for both agents; this is also the cleanest
  "one command to join."

**[decision]** which mode is the demo-1 default, and whether we support both.

---

## What the first demo should be able to demonstrate

Configurable, not hardwired. With 2+ coding agents (mix of Claude Code and Codex)
in one repo, each in its own terminal, the demo should be able to show:

- **Join in ~one command** — each agent joins the shared space and appears in presence.
- **Discovery** — agents can see who else is present and each peer's role/capabilities.
- **Addressability** — broadcast to the space, DM a specific peer, or address by role.
- **Ambient awareness** — each agent's activity streams to the mesh; peers can tell
  what others are doing without being told.
- **Deliberate messaging** — an agent publishes a message on purpose (announce intent,
  ask a peer, hand off work).
- **Control plane** — a directive/command can be sent to an agent and acknowledged.
- **Inbound** — an agent pulls its messages on its own schedule; and (per hosting
  mode) a message can be pushed into a live session.
- **Coordination on a shared workspace** — two agents work the same tree, divide the
  work by talking, and avoid clobbering each other — with **no isolation**.
- **Late join** — a third agent joins midway and catches up from history + presence.

The *topology* (who is "planner" vs "reviewer", who delegates to whom) is
configuration the user sets up — Swarl just provides the primitives.

---

## Open design decisions (you have a say in each)

1. **Hosting mode** — attach (BYO terminal) vs host (`swarl run`) vs both; demo-1
   default. *Keystone — affects push/interrupt and the "one command" story.*
2. **Inbound buffer/policy** — defaults for queue vs coalesce vs immediate; how much
   ambient trace (if any) reaches an agent's attention vs. stays mesh-only.
3. **Message envelope / schema** — how closely to mirror A2A v0.3.0 (Message / Part /
   Artifact / TaskState) and how we add a first-class `role`.
4. **Subject hierarchy** — naming for channels, DMs, traces, control, presence.
5. **Control-plane command set** — which commands ship in demo 1.
6. **Coordination primitives** — intent records / leases (advisory for now): in or
   out, and what shape.
7. **Topology configuration** — how a user declares roles and collaboration patterns
   (config file? per-agent flags? an AgentCard field?).
8. **Codex push parity** — accept Codex as pull-mostly in attach mode, or host Codex
   for full parity.

---

## Draft technical mapping (proposal, not locked)

Grounding for the above, from research — open to revision.

- **Subjects:** `swarl.<space>.chat.broadcast`, `swarl.<space>.chat.dm.<peer>`,
  `swarl.<space>.trace.<agent>`, `swarl.<space>.control.<agent>`,
  `swarl.<space>.presence.<agent>`. (`*` = one token, `>` = trailing tokens.)
- **History:** type-scoped JetStream streams (`CHAT_<space>`, `TRACE_<space>`) with
  `MaxMsgsPerSubject` for bounded per-channel history; late joiners replay via durable
  pull consumers (`DeliverLastPerSubject` for a snapshot, or by start-time for backfill).
- **Presence:** NATS KV bucket per space with **per-key TTL** (requires NATS 2.11+);
  agents heartbeat at ≈ TTL/2.5; `watch` emits join/leave events.
- **Isolation:** one NATS **account** per space.
- **Identity/discovery:** A2A-style **AgentCard** (`name`, `skills[]`, `capabilities`,
  + added `role`) published as a retained KV record (our equivalent of `.well-known`).
- **Naming/addressing vocabulary:** SLIM-inspired `org/namespace/service/instance`
  with anycast / unicast / multicast delivery (maps onto NATS wildcards + queue groups).
- **Transport choices:** core NATS for low-latency DMs/broadcast + request/reply
  control; JetStream for anything needing history or presence. A subject can be both
  live (core subscribers) and recorded (a stream captures it) at once.
