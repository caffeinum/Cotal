<p align="center">
  <img src="assets/header.gif" alt="Swarl — lateral peers in a shared pub/sub space" width="100%" />
</p>

# Swarl

A wire protocol for software — especially AI agents — to coordinate in real time as
**lateral peers in a shared pub/sub space**, instead of as nodes in an orchestrator tree.

[Overview](docs/OVERVIEW.md) · [Architecture](docs/architecture.md) · [Claude Code integration](docs/claude-code-integration.md) · [Examples](docs/examples.md)

## What it is

Participants join a shared **space**, keep **presence**, and talk to each other directly —
broadcast to a channel, message one peer, or reach any one of a role. There's no central
orchestrator on the message path; peers coordinate as equals.

The **wire contract is the standard** — the subjects, the message envelope, and the
presence conventions *are* Swarl. The libraries here are thin clients over them. Transport
is **NATS + JetStream**; the reference implementation is **TypeScript**.

## Quick start

Prerequisites: Node ≥ 20, pnpm, and `nats-server` (v2.11+; macOS: `brew install nats-server`).

```bash
git clone <repo> swarl && cd swarl
pnpm install

pnpm swarl up                                   # start the local mesh (keep running)
pnpm swarl join --space demo --name alice --role planner    # a peer, in its own terminal
pnpm swarl join --space demo --name bob   --role builder    # another peer
pnpm swarl watch --space demo                   # optional: tail everything on the mesh
pnpm swarl console --space demo                 # live dashboard of agents + messages (--plain for a log)
```

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

Every message is one `SwarlMessage` envelope — `{ id, ts, space, from, parts[] }` plus
exactly one target (`channel` / `to` / `toService`) and optional `replyTo` / `contextId`.
Subjects route it:

```
swarl.<space>.chat.<channel>     multicast
swarl.<space>.inst.<instance>    unicast
swarl.<space>.svc.<service>      anycast (queue group)
swarl.<space>.ctl.<service>      control request/reply
```

The source of truth is the code: [`packages/core/src/types.ts`](packages/core/src/types.ts)
(envelope) and [`packages/core/src/subjects.ts`](packages/core/src/subjects.ts) (routing).

## Layout

pnpm + TypeScript ESM monorepo, four dependency tiers (one-way deps):

- **`packages/*`** — the **protocol** (the standard): `@swarl/core` (endpoint, subjects,
  types, the extension registry).
- **`extensions/*`** — **pluggable adapters** that peer-depend on core and self-register
  through its registry: `@swarl/connector` (the Claude Code / Codex MCP bridge, incl. the
  `swarl_spawn` tool) and `@swarl/cmux` (a thin driver over the cmux CLI).
- **`implementations/*`** — **opinionated surfaces** over core: `@swarl/cli` (`swarl` —
  `up`/`join`/`watch`/`console`/`spawn`) and `@swarl/manager` (the agent supervisor —
  `start`/`stop`/`ps`/`attach`, spawning through a `pty`/`tmux`/`cmux` runtime).
- **`examples/*`** — **use-cases** (composition roots). An example only configures +
  orchestrates and picks which extensions to register; it never adds message kinds,
  subjects, or endpoint methods — those go into `core`, generalized.

Deps flow one way: `examples → implementations → packages ← (peer) extensions`.

## Commands

```bash
pnpm swarl <cmd>   # run the CLI (up, join, watch, console, spawn, start, stop, ps, attach)
pnpm smoke         # non-interactive end-to-end check against a running mesh
pnpm typecheck     # tsc --noEmit across all packages
pnpm build         # tsc build across all packages
```

## Status

Today: presence and all three delivery modes over `@swarl/core` with **stream-backed
delivery** (JetStream durable consumers), an **extension registry** the manager resolves
connectors through, and the Claude Code connector under `extensions/`. Manual CLI peers in
[`examples/01`](examples/01-lateral-coordination/README.md); real coding-agent panes — an
orchestrator that grows its team with `swarl_spawn` and routes an API→web handoff — in
[`examples/02`](examples/02-cmux-handoff/README.md). See [examples](docs/examples.md) for
what runs now.
