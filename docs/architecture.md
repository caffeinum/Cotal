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

## Package layout & dependency tiers

Four tiers, one-way dependencies — `packages/` is the standard, everything else builds on
it. `pnpm-workspace.yaml` globs all four (`packages/*`, `extensions/*`, `implementations/*`,
`examples/*`).

- **`packages/*` — core.** The protocol: subjects, schemas, the NATS client, and the generic
  **extension registry**. Everything depends on it; it depends on nothing in the repo.
- **`extensions/*` — pluggable adapters.** A connector (Claude Code, Codex, …) is the first
  extension *kind*; transport / auth could follow. Each is its own package that
  **peer-depends** on core (so it binds to the host's *single* core instance, not a private
  copy) and registers itself through core's typed registry. Chosen by **explicit
  registration** at the composition root — an unknown kind/extension **throws** (no silent
  fallback).
- **`implementations/*` — opinionated surfaces.** CLI, web, … — each a self-contained package
  over core. **Implementations never import each other** — keeps the dependency graph
  acyclic (no import loops).
- **`examples/*` — use cases.** Private (never published) packages — demos, benchmarks. An
  example is the **composition root**: it may depend on *several* implementations and picks
  which extensions to register.

**Why no sideways imports.** Two implementations don't need each other's code to work
together — they're lateral peers that meet **at runtime in a shared space over NATS**, not at
compile time in an import. A demo that runs both a CLI and a web peer just starts each pointed
at the same `space`; coordination flows through the mesh. So the CLI package and the web
package stay independent, each ignorant of the other, and the example wires them.

```
examples ──→ one-or-more implementations ──→ core ←(peer)── extensions
                      (interoperate at runtime over NATS, not via imports)
```

The migration is done: `demos/` use-cases are now `examples/`, `@swarl/connector` is an
`extensions/` connector that **peer-depends** on core and self-registers (`claudeConnector`),
and `@swarl/cli` an `implementations/` package. Core owns the typed **extension registry**; the
manager resolves a connector by agent type from it (unknown ⇒ throws), and an example's
composition root (`examples/01/src/manager.ts`) explicitly registers the connectors it wants.
`@swarl/manager` sits in `packages/` for now because `cli` imports it at compile time — but
it's a supervisor, not protocol, so that's tracked **debt**: the end state is
manager-as-implementation that `cli` reaches over the mesh, not via import.

## Integration surfaces (Claude Code + Codex)

Both target agents expose the same four surfaces, so a single adapter with two backends
covers them. For **Claude Code** the whole adapter ships as one **plugin**, and three of the
four surfaces collapse into a **single dual-purpose MCP server**:

| | Claude Code | Codex CLI |
|---|---|---|
| **Outbound — ambient** | `http` lifecycle hooks → POST to the local daemon (native http hook, no curl shim) | Hooks + `notify`, or `codex exec --json` event stream → mesh |
| **Outbound — deliberate** | MCP tools `swarl_send`/`swarl_dm`/`swarl_anycast` *(same server as the channel)* | MCP tools (same) |
| **Inbound — pull** | MCP tool `swarl_inbox` *(same server)* | MCP tool (same) |
| **Inbound — push** | Two native paths — see below | app-server `turn/*` (live) / `resume` (between-turns) |

**The dual-purpose server.** A Claude Code *channel* **is** an MCP server that declares the
`claude/channel` capability and pushes events via `notifications/claude/channel`. So one
Swarl MCP server is simultaneously the channel (push), the deliberate-out tools
(`swarl_send`/`swarl_dm`/`swarl_anycast` — one per addressing mode, doubling as the channel's
"reply tools"), and `swarl_inbox` (pull): one process, one stdio connection.
Inbound mesh messages arrive in context as
`<channel source="swarl" from="bob" kind="dm" channel="general">…</channel>`; each meta key
becomes a tag attribute the agent can read for routing.

**Two injection paths (different control profiles), composed.**

- **Channel notifications** — async push. We own `content` and tag attributes fully, and the
  daemon owns *emit* timing (drop / queue / coalesce / release — the policy layer). The model
  *sees* it: idle agent → ~immediately (the event wakes a turn — **empirically verified**, see
  *Constraints*); busy agent → at the next **turn boundary** (queued events coalesce into one
  batch); mid-turn interrupt → **not in attach mode**. Research-preview gated (see *Constraints*).
- **Hook `additionalContext`** — deterministic. A hook is *our* code at a fixed lifecycle
  point, not research-preview gated. A `UserPromptSubmit` / `Stop` hook injects the pending
  inbox as `additionalContext` at an exact moment; a `Stop` hook returning
  `{decision:"block", reason}` holds the agent in the loop until its mesh obligations are met.

Hooks are the **spine** (no gating, fully deterministic, turn-boundary delivery + the
keep-working lever); the **channel** adds async "wake me when idle/away."

**Permission relay (same channel, control-plane payoff).** The channel protocol also carries
*tool-permission* requests, so tool approval can happen **over the mesh** on the same dual-purpose
server — no extra transport. The agent declares the `claude/channel/permission` capability; a
pending tool call surfaces as `notifications/claude/channel/permission_request`
(`{request_id, tool_name, description, input_preview}`) which the daemon relays onto the mesh, and
a verdict returns via `notifications/claude/channel/permission` (`{request_id,
behavior:"allow"|"deny"}`). A peer — a human at the CLI, a future moderator, or a policy node —
can then admit or deny an agent's action *through Swarl*, making tool approval a first-class
control-plane flow rather than a per-terminal prompt. (Claude Code ≥ v2.1.81; same research-preview
gating as the channel.)

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

**Lifecycle = two planes.** *Observing* lifecycle (alive? idle / working / offline) is
**mesh-native via presence** — the agent self-reports through its plugin, so `ps` / `status`
read presence and work **regardless of how the agent was launched** (manager-spawned, a human's
own terminal, or headless). *Forcing* lifecycle (start / stop / restart) is the only part that
needs an OS handle on the process. So the manager owns processes to *control* them, but observes
everything through the mesh — and a BYO-terminal agent the manager never spawned still shows up
and reports status.

**Spawn via a pluggable `Runtime` (no tmux dependency).** Starting / stopping / attaching is
abstracted behind one interface (`spawn → handle`, `stop`, `status`, `attach`, optional
`interrupt`) with selectable backends — think *pm2 / docker for agent TUIs*:
- **`pty` (default)** — the manager spawns the real `claude`/Codex (plugin + env) in a
  pseudo-terminal it owns via **`@lydell/node-pty`** (prebuilt binaries for mac/Linux/Windows ×
  x64/arm64 — zero compiler, zero `node-gyp`, ABI-stable). A real native TUI; the human watches
  or types in via `swarl attach <name>` (stream the PTY), and the manager keeps full OS-signal
  control (group-kill, restart). No external software to install.
- **`tmux` / `iTerm2` (opt-in)** — for users already living in a multiplexer who want native
  panes / persistence; auto-detect (if already inside tmux, use it).
- **`cmux` (implemented, as an extension)** — spawn into a new cmux pane on the fly. This is the
  first **pluggable `Runtime`** (a new extension kind beside `Connector`): `extensions/cmux`
  self-registers, and the manager resolves the spawn backend *by name from the registry* — no
  cmux specifics in core. It does `new-split` + `send` the launch line into the freshly-focused
  pane (best-effort — cmux has no "run-in-split" flag), letting an agent grow the team *visibly*
  (see `examples/02`'s `--spawn`). The manager's own built-ins are `tmux` / `detached`; `cmux`
  rides in as a `Runtime`; `pty` / `byo` / `host` are the planned set above.
- **`byo` (floor)** — the manager doesn't own the process; a human runs `swarl claude --role …`
  in their own terminal and the manager just tracks it via presence.
- **`host` (upgrade)** — headless via the Agent SDK / Codex app-server for structured control +
  true mid-turn interrupt; no native TUI (rendered from the event stream), observed via
  `swarl watch`.

The PTY carries the agent's **terminal I/O only** — its mesh traffic still flows agent↔NATS
directly through the plugin, so owning the PTY doesn't put the manager on the message hot path.
**Restart-with-continuity:** a `pty`/`host` restart can `claude --resume <session_id>` to keep
the same context — and therefore the same instance id (see *Instance continuity*).

**Console (watching agents).** The first cut ships today as `swarl console` — a terminal,
mesh-only observer that registers no presence and taps every subject in the space. It renders
a **live dashboard**: a fixed panel of every agent with per-agent colors, status, activity, and
last-seen, above a scrolling message log (recipient ids resolved to names; fan-out coalesced).
`--plain` (or a non-TTY pipe) falls back to the classic scrolling log — the same renderer as
`swarl watch`. The browser/PTY-attach viewer below is the later evolution that adds the terminal
*pixels* on top of this mesh view.

The viewer is a **separate entity** from the manager, but the
terminal *stream* comes from whoever owns the PTY (the manager), **not over the mesh** — PTY
frames are high-bandwidth terminal I/O, and routing them through NATS would put the manager back
on the message hot path. So the console uses **two channels**: the **mesh** (presence / `ps`) to
discover *which* agents exist and their status, and a **direct attach connection** to the PTY
owner for the actual pixels (same stream `swarl attach` consumes, just rendered in a browser).
- **Stack:** **xterm.js** (`@xterm/xterm` + official addons `addon-fit`, `addon-webgl`,
  `addon-attach`, `addon-serialize` — all MIT, zero-dep) for the terminal, in **our own
  lightweight UI** (no framework lock-in, no forked dashboard). The manager exposes a local
  **attach endpoint** (HTTP + WebSocket) that bridges PTY ↔ browser; `addon-attach` wires a pane
  straight to that socket, `addon-serialize` replays scrollback on late attach.
- **Topology:** the manager hosts the attach endpoint (it holds the PTYs); the **console** is a
  thin client that can run in-process (manager serves the page) now, or split later into a
  standalone `swarl console` node that discovers managers over the mesh and aggregates their
  streams.

**Control schema (first cut):** `start {role, name, agent}` · `stop {instance}` · `ps` ·
`status {instance}` · `attach {instance}` · `bind {instance, config}` — control-plane
request/reply messages any authorized node (CLI, dashboard, or an agent) can send; spawning is
policy-gated.

**Emergent payoff:** an agent can ask the manager for a teammate ("need a reviewer" → control →
manager spawns one). The new agent is a *peer*, not a child. This is wired today: the connector
exposes a **`swarl_spawn`** MCP tool that sends `{op:"start"}` to the manager — see `examples/02`,
where a `spawner` agent grows its own team into cmux panes.

## Hosting & onboarding

**Onboarding — manager-driven, still pure native.** You don't `exec claude` yourself; you ask
the **manager** to start an agent (over the control plane) and it performs the launch in a PTY it
owns (default `pty` runtime — see *Manager*):

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

- **Attach mode (demo default)** — the **manager** launches the agent as a native TUI in a PTY
  it owns (`@lydell/node-pty`, default `pty` runtime); you watch / drive it with `swarl attach`.
  Swarl attaches via the plugin (dual MCP server + http hooks). Soft / between-turn push via the
  channel plus deterministic hook injection. Codex is **pull-mostly** (its plain TUI has no clean
  external-injection path).
- **Host mode (upgrade path)** — the manager runs the session headless via the Agent SDK
  (`@anthropic-ai/claude-agent-sdk`, streaming input) / Codex app-server for true mid-turn
  interrupt on both agents; observed via `swarl watch` rather than a native TUI. Documented,
  not built for the demo.

**Constraints (accepted).** Channels are a **research preview** (Claude Code ≥ v2.1.80; permission
relay ≥ v2.1.81): they require Anthropic auth (claude.ai or Console key — *not* Bedrock / Vertex /
Foundry), Team / Enterprise admins must enable them, and a custom (non-allowlisted) channel
launches with `--dangerously-load-development-channels plugin:swarl@…` rather than `--channels`;
the flag / protocol may still change. **Verified** on Claude Code 2.1.160: a `notifications/claude/
channel` event delivered to an otherwise-**idle** session autonomously wakes a turn (no keystroke,
no `send-keys`) — so the channel is the **wake** path: a peer message fires a content-less *nudge*
that pokes an idle session into a turn. Delivery itself is the durable DM/chat stream consumer:
the woken turn's `UserPromptSubmit` hook drains the inbox, injects the messages, and **acks** them
(the single, gating-free delivery path). The nudge never acks or removes anything, so if the channel
can't run the message simply waits on the stream for the next turn — nothing is lost.

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

**Status.** *Built today:* all three delivery modes over **JetStream streams** (durable
per-reader consumers, explicit ack-on-surface, `Nats-Msg-Id` dedup), presence via a KV bucket,
control plane via a hand-rolled queue subscription. *Decided next:* swap the control plane to
the **NATS Services API**, and move the rest of the routing meta into **message headers** (only
`Nats-Msg-Id` lives there today; the envelope is still JSON in the body). The subject names and
envelope shape below are stable across both.

**Why streams, not fire-and-forget.** Core NATS is at-most-once: a message is delivered only
to whoever is subscribed *at that instant*. Agents are constantly `working` / `offline`, so a
DM, a task, or a channel post sent while an agent is mid-turn is silently lost. JetStream
**stores** each message and gives every reader its own bookmark, so an agent catches up *at
its own pace* when it frees up — nothing missed, no interruption required. One mechanism then
covers three things at once: live delivery, the inbound buffer, and late-join history.

- **Subjects (delivery modes):** publishers write to the same subjects; the difference is
  *who consumes* the backing stream.
  - multicast → `swarl.<space>.chat.<channel>`  — broadcast to a channel
  - unicast → `swarl.<space>.inst.<instance>`  — one specific endpoint
  - anycast → `swarl.<space>.svc.<service>`  — any one instance of a service (role)
  - trace → `swarl.<space>.trace.<instance>`, control → `swarl.<space>.control.<instance>` *(later)*
  - `*` = one token, `>` = trailing tokens; `swarl.<space>.>` taps everything (the `watch` command).
- **Streams (one model, three read patterns):**
  - **`CHAT_<space>`** (multicast) — captures `chat.>`, **Limits** retention with
    `MaxMsgsPerSubject` (a capped per-channel backlog). **Every** agent reads **every**
    message via its **own** consumer/bookmark, at its own pace; a late joiner replays the
    window. This *is* both the inbound channel buffer and history.
  - **`DM_<space>`** (unicast) — captures `inst.>`, **Limits** retention. Each agent has a
    **per-instance durable consumer** (durable name = instance id, filter `inst.<id>`) — its
    private inbox. Retained for **session length**: the inbox lives as long as the agent's
    context does (an `InactiveThreshold` retires the consumer when the context ends, so a
    retired/`new`-context id never inherits a stale inbox — mirrors the *Instance continuity*
    rule). `swarl_inbox` = pull the unread batch; push = the consumer delivers on attach.
  - **`TASK_<space>`** (anycast) — captures `svc.>`, **WorkQueuePolicy**. A **shared pull
    consumer per service** (filter `svc.<role>`): a task with no worker online *waits*; the
    first available instance of the role grabs it; multiple online instances load-balance; the
    task is removed once acked. Durable replacement for the old core queue-group, which dropped
    the task if no one was subscribed.
  - **Acks** are explicit and happen when a message is actually surfaced/injected (not on
    pull), so a crash before injection redelivers (`AckExplicit` + `AckWait`).
- **Presence:** NATS **KV bucket per space** (key = instance id), bucket-level TTL + a
  client-side expiry sweep (correct without relying on server delete-markers — per-key TTL on
  an updated key is unreliable on current servers, and heartbeats re-put the same key). States:
  `idle` / `waiting` / `working` / `offline`. Heartbeat ≈ TTL/3; graceful leave publishes a
  final `offline`; a lapsed heartbeat is swept to `offline`. Offline peers stay in the roster.
  (Instant offline via `$SYS` disconnect events is a documented upgrade — see *Deferred*.)
- **Identity/discovery:** A2A `AgentCard` (`id`=instance, `name`=handle, `role`=service,
  `kind`, `skills`/`tags`) carried in the presence record (our equivalent of `.well-known`).
  We omit A2A's `capabilities` field (protocol flags Swarl doesn't need) to avoid the name
  collision — "what it can do" lives in `skills`/`tags`.
- **Message envelope:** `{ id, ts, space, from:{id,name,role}, channel?, to?, toService?,
  parts[], replyTo?, contextId? }`. Routing meta (`id`, `from.id`, `contextId`, `replyTo`)
  moves to **NATS headers** — `id` as `Nats-Msg-Id` gives free server-side **dedup** under
  JetStream redelivery, and lets the buffer/policy layer peek (who / kind) without decoding the
  body; `parts[]` stay in the body. Exactly one delivery target: `channel` = multicast, `to` =
  unicast (instance), `toService` = anycast (service).
- **Artifacts:** large `data` parts / A2A `Artifact`s exceed the ~1 MB message cap, so they go
  to a **JetStream Object Store** bucket per space (chunked); the message carries a reference
  part `{ kind:"artifact", ref:{ bucket, name, size, mime } }` and the recipient fetches on
  demand. (Part shape reserved now; delivery later.)
- **Control plane:** the **NATS Services API** (`micro`) — the manager registers a service
  (endpoints `start`/`stop`/`ps`/`status`/`bind` under `ctl.<service>`, auto queue-grouped),
  which brings built-in **discovery** (`$SRV.PING`/`INFO`) and **stats** for free. The
  `ControlRequest`/`ControlReply` envelope is unchanged; only the transport underneath swaps.
- **Isolation:** one NATS **account** per space (later: split `space` into `org/namespace`).
- **Transport choice:** JetStream streams for all three delivery modes (durability + per-reader
  bookmarks + history), KV for presence, Object Store for artifacts, and the Services API for
  the control plane.

## Deferred (designed-for, not built)

- **Sessions + moderator** — managed group membership (admit/remove), per SLIM's Group session.
- **Verifiable identity** — `instance` becomes a `did:key`; messages signed, peers verify;
  the natural pairing is NATS **NKey/JWT** decentralized auth over the account-per-space split.
- **Instant offline (`$SYS`)** — subscribe the manager to `$SYS.ACCOUNT.<id>.DISCONNECT` for
  immediate offline detection instead of waiting out the heartbeat window. Needs `system_account`
  config + a privileged connection, connection names that carry the instance id (not just the
  handle), and the manager as presence reconciler (a dead agent can't mark itself offline). The
  heartbeat sweep remains the floor when no reconciler is running.
- **Artifact delivery** — the Object Store path above (shape reserved, transfer not built).
