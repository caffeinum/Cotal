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

## Try it in 2 minutes

**Prerequisites:** Node ≥ 20 · [pnpm](https://pnpm.io) · **`nats-server`** (v2.11+).
Cotal *spawns* `nats-server` — it doesn't bundle it, so install it first:
`brew install nats-server` (macOS) or see [nats.io](https://docs.nats.io/running-a-nats-service/introduction/installation).

```bash
git clone https://github.com/Cotal-AI/Cotal.git cotal && cd cotal
pnpm install
```

Then, each in its own terminal:

```bash
pnpm cotal up --open                                          # 1. start the local mesh (keep it running)
pnpm cotal join --space demo --name alice --role planner      # 2. a peer
pnpm cotal join --space demo --name bob   --role builder      # 3. another peer
pnpm cotal watch --space demo                                 # 4. (optional) tail everything on the mesh
```

Type a line in a `join` terminal to broadcast it to the space; the other peer and `watch`
see it instantly. In-session verbs drive the rest:

| Verb | Does |
|---|---|
| `/who` | show the live roster (names, roles, states) |
| `/dm <name> <msg>` | message one peer directly (unicast) |
| `/anycast <role> <msg>` | reach *any one* peer of a role |
| `/working` · `/waiting` · `/idle` | set your presence state |
| `/quit` | leave (peers see you go `offline`) |

Prefer a dashboard? `pnpm cotal console --space demo` (terminal UI) or
`pnpm cotal web --space demo` (browser, [docs](docs/web.md)) show presence, channels, and a
live feed.

<p align="center">
  <img src="assets/dashboard.png" alt="Cotal web dashboard — presence roster, channels, live activity feed, and a Needs You panel" width="100%" />
</p>

These dashboards are **example surfaces built on the protocol** — not part of the standard.
Each is a thin client that subscribes to a space and renders what's already on the wire: the
**presence** roster, the **channels** peers broadcast on, the **live feed** of every message
(chat, unicast, anycast), and a **Needs You** panel for the moments a human has to step in.
Nothing here is privileged; any peer could compute the same from the presence and message
streams.

Full walkthrough: [examples/01-lateral-coordination](examples/01-lateral-coordination/README.md).

> `cotal up` enforces **JWT auth by default** (agents present minted creds); `--open` runs
> the unauthenticated dev mesh used above. See [architecture](docs/architecture.md) →
> *Identity & authorization*.

## Get real agents coordinating

The same mesh carries **coding agents**. Through the manager, a `cotal start --agent claude`
spawns a real Claude Code session that joins the space and coordinates with its peers over
`cotal_*` MCP tools (`cotal_dm`, `cotal_roster`, `cotal_spawn`, …):

```bash
pnpm cotal up --open                                        # mesh
(cd examples/01-lateral-coordination && pnpm manager)       # manager + console (http://127.0.0.1:7878)
pnpm cotal start --space demo --agent claude --name ada   --role planner
pnpm cotal start --space demo --agent claude --name linus --role reviewer
```

This needs the Claude Code plugin (research preview) — setup in
[docs/claude-code-integration.md](docs/claude-code-integration.md). For a richer demo — an
orchestrator that grows its own team with `cotal_spawn` and routes an API→web handoff across
parallel [cmux](https://cmux.com) sessions — see
[examples/02-cmux-handoff](examples/02-cmux-handoff/README.md).

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

- **`packages/*`** — the **protocol** (the standard): `@cotal-ai/core` (endpoint, subjects,
  types, the extension registry).
- **`extensions/*`** — **pluggable adapters** that peer-depend on core and self-register
  through its registry: `@cotal-ai/connector-core` (the shared MCP-bridge runtime — mesh agent
  + `cotal_*` tools incl. `cotal_spawn` + hook relay), `@cotal-ai/connector-claude-code`,
  `@cotal-ai/connector-codex` and `@cotal-ai/connector-hermes` (thin adapters over it), and
  `@cotal-ai/cmux` (a driver over the cmux CLI).
- **`implementations/*`** — **opinionated surfaces** over core: `@cotal-ai/cli` (`cotal` —
  `up`/`join`/`watch`/`console`/`web`/`spawn`/`mint`) and `@cotal-ai/manager` (the agent
  supervisor — `start`/`stop`/`ps`/`attach`, spawning through a `pty`/`tmux`/`cmux` runtime).
- **`examples/*`** — **use-cases** (composition roots). An example only configures +
  orchestrates and picks which extensions to register; it never adds message kinds,
  subjects, or endpoint methods — those go into `core`, generalized.

Deps flow one way: `examples → implementations → packages ← (peer) extensions`.

```bash
pnpm cotal <cmd>   # the CLI (up, join, watch, console, web, spawn, mint, start, stop, ps, attach)
pnpm smoke         # non-interactive end-to-end check against a running mesh
pnpm typecheck     # tsc --noEmit across all packages
pnpm build         # tsc build across all packages
```

## Troubleshooting

- **`nats-server: command not found`** — install it (`brew install nats-server`); Cotal
  spawns it, it isn't bundled.
- **Port already in use** — NATS defaults to `4222`, the web dashboard to `7799`. Free the
  port, or pass `cotal web --port <n>`. `cotal up` reuses a NATS already running on `4222`.
- **Agents rejected / `authorization violation`** — you're on the auth mesh; use
  `cotal up --open` for local dev, or mint creds (`cotal mint`).
- **Nothing happens on first run** — make sure `pnpm install` completed and the
  `cotal up` terminal is still running.

## License

Apache-2.0 — see [LICENSE](LICENSE). The reasoning (why permissive, the trademark, and
future commercial terms) is in [LICENSING.md](LICENSING.md).
