<p align="center">
  <img src="assets/header.gif" alt="Cotal — lateral peers in a shared pub/sub space" width="100%" />
</p>

# Cotal

A wire protocol for software — especially AI agents — to coordinate in real time as
**lateral peers in a shared pub/sub space**, instead of as nodes in an orchestrator tree.

[Overview](docs/OVERVIEW.md) · [Architecture](docs/architecture.md) · [Claude Code integration](docs/claude-code-integration.md) · [Agent frameworks](docs/agent-frameworks.md) · [Examples](docs/examples.md)

## What it is

Participants join a shared **space**, keep **presence**, and talk to each other directly —
broadcast to a channel, message one peer, or reach any one of a role. There's no central
orchestrator on the message path; peers coordinate as equals.

The **wire contract is the standard** — the subjects, the message envelope, and the
presence conventions *are* Cotal. The libraries here are thin clients over them. Transport
is **NATS + JetStream**; the reference implementation is **TypeScript**.

<p align="center">
  <img src="assets/dashboard.png" alt="Cotal web dashboard — presence roster, channels, live activity feed, and a Needs You panel" width="100%" />
</p>

An **example surface built on the protocol** — not part of the standard itself. It's a thin
client that subscribes to a space and renders what's already on the wire: the **presence**
roster down the left (who's online, their role and state), the **channels** they broadcast
on, the **live feed** of every message (chat, unicast, anycast), and a **Needs You** panel
that surfaces the moments a human has to step in — a blocked peer, a failed task, an
unclaimed anycast request, an approval. Nothing here is privileged; anything it shows, any
peer could compute from the same presence and message streams.

## Quick start

Prerequisites: Node ≥ 20, pnpm, and `nats-server` (v2.11+; macOS: `brew install nats-server`).

```bash
git clone <repo> cotal && cd cotal
pnpm install

pnpm cotal up --open                            # start the local mesh, unauthenticated (keep running)
pnpm cotal join --space demo --name alice --role planner    # a peer, in its own terminal
pnpm cotal join --space demo --name bob   --role builder    # another peer
pnpm cotal watch --space demo                   # optional: tail everything on the mesh
pnpm cotal console --space demo                 # live dashboard of agents + messages (--plain for a log)
pnpm cotal web --space demo                      # browser observability: presence, channels, live feed ([docs](docs/web.md))
```

`cotal up` enables **JWT auth by default** (agents need minted creds); `--open` runs the
unauthenticated dev mesh used above. See [docs/architecture.md](docs/architecture.md) →
*Identity & authorization*.

Inside a `join` session, type a line to broadcast it; `/who`, `/dm`, `/anycast`,
`/working`, `/waiting`, `/idle`, `/me`, `/quit` drive the rest. Full walkthrough:
[examples/01-lateral-coordination](examples/01-lateral-coordination/README.md).

## Core model

- **Endpoint** — any software on the mesh: a long-lived connection with its own presence.
- **Agent node** — an endpoint with identity, role, and tags (an A2A-style `AgentCard`).
- **Space** — one collaboration, isolated from other spaces.
- **Channel** — a named topic participants broadcast on and subscribe to.
- **Presence** — a live roster with each peer's card and state: `idle` / `waiting` /
  `working` / `offline`.

Three delivery modes:

| Mode | Reaches | Use |
|---|---|---|
| **multicast** | everyone on a channel | broadcast to the group |
| **unicast** | one specific peer | a direct message |
| **anycast** | *any one* instance of a role | "whoever is a reviewer" |

## The wire contract

Every message is one `CotalMessage` envelope — `{ id, ts, space, from, parts[] }` plus
exactly one target (`channel` / `to` / `toService`) and optional `replyTo` / `contextId`.
Subjects route it:

```
cotal.<space>.chat.<channel>     multicast
cotal.<space>.inst.<instance>    unicast
cotal.<space>.svc.<service>      anycast (queue group)
cotal.<space>.ctl.<service>      control request/reply
```

The source of truth is the code: [`packages/core/src/types.ts`](packages/core/src/types.ts)
(envelope) and [`packages/core/src/subjects.ts`](packages/core/src/subjects.ts) (routing).

## Layout

pnpm + TypeScript ESM monorepo, four dependency tiers (one-way deps):

- **`packages/*`** — the **protocol** (the standard): `@cotal/core` (endpoint, subjects,
  types, the extension registry).
- **`extensions/*`** — **pluggable adapters** that peer-depend on core and self-register
  through its registry: `@cotal/connector` (the Claude Code / Codex MCP bridge, incl. the
  `cotal_spawn` tool) and `@cotal/cmux` (a thin driver over the cmux CLI).
- **`implementations/*`** — **opinionated surfaces** over core: `@cotal/cli` (`cotal` —
  `up`/`join`/`watch`/`console`/`spawn`) and `@cotal/manager` (the agent supervisor —
  `start`/`stop`/`ps`/`attach`, spawning through a `pty`/`tmux`/`cmux` runtime).
- **`examples/*`** — **use-cases** (composition roots). An example only configures +
  orchestrates and picks which extensions to register; it never adds message kinds,
  subjects, or endpoint methods — those go into `core`, generalized.

Deps flow one way: `examples → implementations → packages ← (peer) extensions`.

## Commands

```bash
pnpm cotal <cmd>   # run the CLI (up, join, watch, console, spawn, start, stop, ps, attach)
pnpm smoke         # non-interactive end-to-end check against a running mesh
pnpm typecheck     # tsc --noEmit across all packages
pnpm build         # tsc build across all packages
```

## Status

Today: presence and all three delivery modes over `@cotal/core` with **stream-backed
delivery** (JetStream durable consumers), an **extension registry** the manager resolves
connectors through, and the Claude Code connector under `extensions/`. Manual CLI peers in
[`examples/01`](examples/01-lateral-coordination/README.md); real coding-agent panes — an
orchestrator that grows its team with `cotal_spawn` and routes an API→web handoff — in
[`examples/02`](examples/02-cmux-handoff/README.md). See [examples](docs/examples.md) for
what runs now. Agents built with other SDKs join as native peers too — the OpenAI Agents
and Vercel AI adapters under [`extensions/`](docs/agent-frameworks.md).

## License

Apache-2.0 — see [LICENSE](LICENSE). The reasoning (why permissive, the trademark, and
future commercial terms) is in [LICENSING.md](LICENSING.md).
