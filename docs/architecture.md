# Swarl — Architecture notes (draft)

> Implementation detail and research grounding, split out of [OVERVIEW.md](OVERVIEW.md)
> to keep the overview lean. All proposals, not locked.

## Influences: A2A + SLIM

Swarl borrows vocabulary and shapes from two agent frameworks so we stay interoperable
rather than siloed — but implements them over NATS/JetStream.

**From A2A** — the *data shapes*: `AgentCard` (identity / role / capabilities / skills),
`Message` / `Part` (text & data), `Artifact`, and correlation ids (`contextId`). We do
**not** adopt A2A's HTTP/JSON-RPC transport, `Task` RPCs, or its request/response server
model — those don't fit lateral pub/sub.

**From SLIM** — the *addressing and delivery model*:
- **Hierarchical address** `space / service / instance` (SLIM's `org/namespace/service/
  instance`). In Swarl: `space` = the collaboration; `service` = the addressable class
  (a role / agent-type, e.g. `reviewer`); `instance` = one specific endpoint.
- **Three delivery modes:** **multicast** (to a channel — everyone), **unicast** (to one
  instance), **anycast** (to *any one* instance of a service — delegation / load-balancing).
- **Sessions + moderator** (managed groups with admit/remove) — *deferred*, but the design
  leaves room for it; channels are open for now.

We do **not** adopt SLIM's Rust data plane, gRPC transport, or MLS encryption — NATS/
JetStream replaces that layer and adds the durability + presence SLIM leaves to the app.

**Identity** is an A2A `AgentCard` whose `instance` id is a throwaway UUID today, shaped
to later become a **DID** (`did:key` — a self-certifying public-key identifier) so identity
can be cryptographically verifiable and decentralized (see *Deferred*).

## Integration surfaces (Claude Code + Codex)

Both target agents expose the same four surfaces, so a single adapter with two backends
covers them. For **Claude Code** the whole adapter ships as one **plugin**, and three of the
four surfaces collapse into a **single dual-purpose MCP server**:

| | Claude Code | Codex CLI |
|---|---|---|
| **Outbound — ambient** | `http` lifecycle hooks → POST to the local daemon (native http hook, no curl shim) | Hooks + `notify`, or `codex exec --json` event stream → mesh |
| **Outbound — deliberate** | MCP tool `swarl_publish` *(same server as the channel)* | MCP tool (same) |
| **Inbound — pull** | MCP tool `swarl_inbox` *(same server)* | MCP tool (same) |
| **Inbound — push** | Two native paths — see below | app-server `turn/*` (live) / `resume` (between-turns) |

**The dual-purpose server.** A Claude Code *channel* **is** an MCP server that declares the
`claude/channel` capability and pushes events via `notifications/claude/channel`. So one
Swarl MCP server is simultaneously the channel (push), `swarl_publish` (deliberate out — and
the channel's "reply tool"), and `swarl_inbox` (pull): one process, one stdio connection.
Inbound mesh messages arrive in context as
`<channel source="swarl" from="bob" kind="dm" channel="general">…</channel>`; each meta key
becomes a tag attribute the agent can read for routing.

**Two injection paths (different control profiles), composed.**

- **Channel notifications** — async push. We own `content` and tag attributes fully, and the
  daemon owns *emit* timing (drop / queue / coalesce / release — the policy layer). The model
  *sees* it: idle agent → ~immediately (the event wakes a turn); busy agent → at the next
  **turn boundary** (queued events coalesce into one batch); mid-turn interrupt → **not in
  attach mode**. Research-preview gated (see *Constraints*).
- **Hook `additionalContext`** — deterministic. A hook is *our* code at a fixed lifecycle
  point, not research-preview gated. A `UserPromptSubmit` / `Stop` hook injects the pending
  inbox as `additionalContext` at an exact moment; a `Stop` hook returning
  `{decision:"block", reason}` holds the agent in the loop until its mesh obligations are met.

Hooks are the **spine** (no gating, fully deterministic, turn-boundary delivery + the
keep-working lever); the **channel** adds async "wake me when idle/away."

**Presence from hooks.** The same lifecycle hooks feed presence: `UserPromptSubmit` /
`PreToolUse` → `working`, `Stop` → `idle`, `Notification` (permission / idle prompt) →
`waiting`, `SessionEnd` → `offline`. Ambient traces reach the mesh for observability but the
policy layer keeps them out of peers' attention — they never become injections.

**What we control (accepted for the demo):**

| | |
|---|---|
| *What* we inject (content, routing meta) | full — daemon-side |
| *Whether* to inject (ambient vs actionable, allowlist, coalesce, rate-limit) | full — daemon policy |
| *When we emit* | full |
| *When the model sees it* | channel: idle→now, busy→turn boundary · hook: exact lifecycle point |
| *Mid-turn interrupt of a busy agent* | host mode only (Agent SDK) |
| *Whether the model acts* on an injection | steered via the server `instructions` + meta tags, not forced |

## Manager (agent supervisor)

The CLI doesn't spawn agents itself — a long-lived **manager** owns their lifecycle, and the
CLI asks it over the mesh. The manager is itself a **node** (presence + a control subject), so
managing Swarl agents happens *through Swarl* — the control plane's first real consumer.

**Supervisor, not orchestrator.** It owns *process lifecycle + config binding* (start / stop /
restart, resolve a role, bind env + policy to a session) — **not** what work agents do. Agents
still coordinate laterally; the manager only births and configures them. (The orchestrator-tree
we rejected was about delegating *work*; this is *infrastructure*.)

**Supervisor-only scope.** The manager is **off the message hot path**: each agent self-connects
to the mesh via its own plugin (own presence, messaging, inbound policy). The manager owns
processes and config, as one node among peers — not a daemon that proxies everyone's traffic.

**Attach-in-panes spawn (demo).** The manager launches each agent as a real native Claude/Codex
TUI in its own terminal pane (tmux), so you watch it directly while it owns start/stop. Host
mode (headless via the Agent SDK / Codex app-server, for mid-turn interrupt) is the
manager-owned upgrade path, observed via `swarl watch`.

**Control schema (first cut):** `start {role, name, agent}` · `stop {instance}` · `ps` ·
`status {instance}` · `bind {instance, config}` — control-plane request/reply messages any
authorized node (CLI, dashboard, or an agent) can send; spawning is policy-gated.

**Emergent payoff:** an agent can ask the manager for a teammate ("need a reviewer" → control →
manager spawns one). The new agent is a *peer*, not a child.

## Hosting & onboarding

**Onboarding — manager-driven, still pure native.** You don't `exec claude` yourself; you ask
the **manager** to start an agent (over the control plane) and it performs the launch in a
terminal pane:

```
swarl start --role planner --name alice      # CLI → control msg → manager spawns it
```

Under the hood the manager runs the *real* `claude` with the plugin attached and identity in the
environment — an ordinary Claude Code terminal, no wrapper in front of it:

```
SWARL_SPACE=demo SWARL_NAME=alice SWARL_ROLE=planner \
  claude --dangerously-load-development-channels plugin:swarl@swarl-mesh
```

The plugin's MCP server reads `SWARL_SPACE` / `SWARL_NAME` / `SWARL_ROLE` at spawn and
**auto-joins**, so the agent is in presence by the time the session is interactive. `SWARL_ROLE`
resolves a **role template** (see *Roles & identity* below) — card, optional persona, channel /
policy defaults — so a role's richness lives in a file, not the launch line. The plugin also
ships `/swarl` slash commands (`/swarl who`, `/swarl dm …`) for in-session control.
(`/plugin install swarl@swarl-mesh` once, beforehand.)

**Hosting mode** still sets how much inbound push is possible:

- **Attach mode (demo default)** — the **manager** launches the agent as a native TUI in its
  own terminal pane; Swarl attaches via the plugin (dual MCP server + http hooks). Soft/
  between-turn push via the channel plus deterministic hook injection. Codex is **pull-mostly**
  (its plain TUI has no clean external-injection path).
- **Host mode (upgrade path)** — the manager runs the session headless via the Agent SDK
  (`@anthropic-ai/claude-agent-sdk`, streaming input) / Codex app-server for true mid-turn
  interrupt on both agents; observed via `swarl watch` rather than a native TUI. Documented,
  not built for the demo.

**Constraints (accepted).** Channels are a **research preview** (Claude Code ≥ v2.1.80): they
require Anthropic auth (claude.ai or Console key — *not* Bedrock / Vertex / Foundry), Team /
Enterprise admins must enable them, and a custom (non-allowlisted) channel launches with
`--dangerously-load-development-channels plugin:swarl@…` rather than `--channels`; the flag /
protocol may still change. The MCP-tools and hooks legs have **no** such gating — the hook
injection path is the gating-free fallback if the channel can't run.

**A channel must gate senders** — an ungated channel is a prompt-injection vector. Swarl gates
on the mesh side: the policy layer only emits notifications for allowlisted peers.

> **Adjacent native feature — Agent teams.** Claude Code ships an experimental
> `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` mode: multiple sessions, a shared task list, and
> peer-to-peer messaging (hook events `TeammateIdle` / `TaskCreated` / `TaskCompleted`). It
> validates the premise but is Claude-only, single-machine, and orchestrator-led. Swarl
> differs by being cross-agent (Codex too), a standardized NATS wire contract, lateral (not a
> tree), and local→cluster.

## Roles & identity

**Identity is an A2A `AgentCard`**: the **instance id** = the SLIM **instance** (this endpoint —
the presence key, `to:` target, future `did:key`); `name` is a cosmetic, reusable human handle
(see *Instance continuity*); `role` = the SLIM **service** (the addressable class). The role
label is therefore *load-bearing* — it's the **anycast** address, so `svc.reviewer` reaches
"whoever is a reviewer," not just a roster label.

A **role** is a reusable template that produces a card, in three layers:

- **Advertisement** (A2A) — `role`, `description`, and `skills[]` (each `id` / `name` /
  `tags` / `examples`), broadcast in presence for discovery + anycast. *We use `skills` +
  `tags` for "what it can do"; A2A's `capabilities` field means protocol flags (streaming,
  push) that Swarl doesn't need yet, so we omit it to avoid the name collision.*
- **Persona** (optional — CrewAI-style role / goal / backstory) — free-text instructions that
  condition the session, injected via the MCP server `instructions` + a `SessionStart` hook.
  Omit it for a pure-primitive role; include it for a batteries-included specialist.
- **Runtime defaults** (Swarl) — `channels` to auto-subscribe, inbound `policy`
  (`push-on-dm` / `pull-only` / `coalesce`), optional `model` / `effort`.

**File format** — `<role>.md`, mirroring the `SKILL.md` / agent idiom: structured fields in
YAML frontmatter (the machine-readable card + runtime), the markdown body is the optional
persona (the system prompt).

```markdown
---
role: reviewer                       # → A2A service / anycast address
description: Reviews diffs for correctness, security, and style.
skills:
  - id: diff-review
    name: Diff review
    tags: [review, correctness, security]
channels: [general, reviews]         # auto-subscribe on join
inbound: push-on-dm                  # buffer/policy default
model: sonnet                        # optional
---

You are a reviewer on a shared Swarl mesh. Catch correctness and security issues in
peers' diffs before they land; DM the author, post a one-line summary to #reviews.
```

**Resolution & storage.** The plugin's MCP server resolves the role at spawn from `SWARL_ROLE`
(+ `SWARL_NAME` as the human label), reading `<role>.md` from `.swarl/roles/` (project,
version-controlled) layered over `~/.swarl/roles/` (user). So personas work in the pure-native
launch with **no CLI required**; a bare `SWARL_ROLE=reviewer` with no file falls back to a
label-only card.

**Instance continuity.** The instance id must track *context* continuity, not the human label.
`name` (e.g. `alice`) is a reusable, cosmetic handle; the **instance id** is the unique
addressable endpoint — the presence KV key, the `to:` target, the future `did:key`. Bind it to
the session's context: a **resumed** session (same Claude Code `session_id`, same context
window) keeps the **same** instance id, so presence, `contextId` correlation, and in-flight DMs
stay continuous. A **fresh** context window — even reusing the same `name` — is a **new**
instance with a **new** id; it must *not* inherit the prior one. Reusing an id across a
discontinuous context tells peers "same agent, same memory" when the new session has none —
breaking reply correlation, mis-delivering messages meant for the original, and wrongly
inheriting its leases/obligations. Rule: **same context ⇒ same id; new context ⇒ new id**, with
`name` as the stable handle that may map to different instances over time.

**CLI (optional ergonomics).**

```
swarl role new reviewer            # scaffold .swarl/roles/reviewer.md ($EDITOR or flags)
swarl role list | show reviewer
swarl join claude --role reviewer --name carol   # resolve the role, build the card, exec native claude
```

`swarl join claude …` is sugar over the env launch: it resolves the role file, sets the env,
and `exec`s the real `claude` with the plugin — the session stays pure Claude Code. Inline
`--description` / `--skill` override the file for a one-off that doesn't deserve a saved role.

## Technical mapping (NATS / JetStream)

**Status:** implemented = all three delivery modes (multicast / unicast / anycast) +
presence with states. Later = trace/control families, message history.

- **Subjects (delivery modes):**
  - multicast → `swarl.<space>.chat.<channel>`  — broadcast to a channel
  - unicast → `swarl.<space>.inst.<instance>`  — one specific endpoint
  - anycast → `swarl.<space>.svc.<service>`  — subscribers join NATS **queue group**
    `<service>` (= role), so one publish reaches exactly one instance
  - trace → `swarl.<space>.trace.<instance>`, control → `swarl.<space>.control.<instance>` *(later)*
  - `*` = one token, `>` = trailing tokens; `swarl.<space>.>` taps everything (the `watch` command).
- **Presence:** NATS **KV bucket per space** (key = instance id), bucket-level TTL + a
  client-side expiry sweep (correct without relying on server delete-markers). States:
  `idle` / `waiting` / `working` / `offline`. Heartbeat ≈ TTL/3; graceful leave publishes a
  final `offline`; a lapsed heartbeat is swept to `offline`. Offline peers stay in the roster.
- **Identity/discovery:** A2A `AgentCard` (`id`=instance, `name`=handle, `role`=service,
  `kind`, `skills`/`tags`) carried in the presence record (our equivalent of `.well-known`).
  We omit A2A's `capabilities` field (protocol flags Swarl doesn't need) to avoid the name
  collision — "what it can do" lives in `skills`/`tags`.
- **Message envelope:** `{ id, ts, space, from:{id,name,role}, channel?, to?, toService?,
  parts[], replyTo?, contextId? }`, JSON on the wire. Exactly one delivery target: `channel`
  = multicast, `to` = unicast (instance), `toService` = anycast (service).
- **History:** type-scoped JetStream streams (`CHAT_<space>`) with `MaxMsgsPerSubject`;
  late joiners replay via durable pull consumers — *later* (chat is fire-and-forget today).
- **Isolation:** one NATS **account** per space (later: split `space` into `org/namespace`).
- **Transport choice:** core NATS for live multicast/unicast/anycast + request/reply
  control; JetStream for presence (KV) and history.

## Deferred (designed-for, not built)

- **Sessions + moderator** — managed group membership (admit/remove), per SLIM's Group session.
- **Verifiable identity** — `instance` becomes a `did:key`; messages signed, peers verify.
- **Message history / late-join replay** — the JetStream streams described above.
