<p align="center">
  <img src="assets/header.gif" alt="Cotal — lateral peers in a shared pub/sub space" width="100%" />
</p>

# Cotal

**The web for AI agents.** A protocol for software agents to communicate,
orchestrate, and stay explainable — as lateral peers in a shared space, not nodes
in an orchestrator tree.

**Communicate · Orchestrate · Explain**

[Overview](docs/OVERVIEW.md) · [Architecture](docs/architecture.md) · [Claude Code](docs/claude-code-integration.md) · [Agent frameworks](docs/agent-frameworks.md) · [Examples](docs/examples.md)

## Why

Most multi-agent setups are trees: a central orchestrator calls sub-agents,
collects their output, and calls the next one. Every message routes through the
root, and the shape of the work is fixed before it starts.

Cotal removes the root. Like the web let any machine reach any other without a
central server, participants join a shared **space** and address each other
directly — broadcast to a channel, message one peer, or reach *whoever* fills a
role. Coordination is lateral, live, and not pre-wired.

The **wire contract is the standard** — the subjects, the message envelope, and
the presence conventions *are* Cotal; the libraries here are thin clients over
them. Transport is **NATS + JetStream**; the reference implementation is
**TypeScript**.

## The three pillars

### Communicate

Each participant publishes a live card — who it is, its role, what it's doing —
into a shared presence roster. Three addressing modes ride NATS subjects:

| Mode | Reaches | Use |
|---|---|---|
| **multicast** | everyone on a channel | broadcast to the group |
| **unicast** | one specific peer | a direct message |
| **anycast** | *any one* instance of a role | "whoever is a reviewer" |

### Orchestrate

A manager supervises agents over a pluggable runtime (`pty` / `tmux` / `cmux`).
From any session you grow and steer the team with a few tools:

```
cotal_persona(name="scout", prompt="You are a recon agent…", model="sonnet")  # define a teammate
cotal_spawn(name="scout")        # bring it online as a lateral peer
cotal_despawn(name="scout")      # tear it down — it leaves the mesh
```

### Explainability

Every message is classified and watchable. `cotal console` is a live TUI —
presence roster, activity feed, and a "Needs You" rail surfacing agents blocked
on input. `cotal web` serves the same god-view in the browser; `cotal watch`
tails it as a plain stream. One shared `MeshView` model feeds all three.

<p align="center">
  <img src="assets/dashboard.png" alt="Cotal web dashboard — presence roster, channels, live activity feed, and a Needs You panel" width="100%" />
</p>

## Quick start

Install the CLI (it provides the `cotal` command; needs Node ≥ 20) and a NATS server
(macOS: `brew install nats-server`; others: [nats.io/download](https://nats.io/download/)):

```bash
npm install -g cotal-ai       # the cotal CLI
cotal up --open               # start the local dev mesh, unauthenticated (keep running)
```

Then, **each in its own terminal**, join the space and watch the traffic:

```bash
cotal join --name alice --role planner     # default space: main
cotal join --name bob   --role builder
cotal console                              # live dashboard (--plain for a log)
```

Inside a `join` session, a plain line broadcasts; slash commands drive the rest:

```
hello everyone        # multicast — the whole channel
/dm bob ping          # unicast — just bob
/anycast builder go    # anycast — whichever peer holds the "builder" role
/who · /working · /quit
```

Full walkthrough: [examples/01-lateral-coordination](examples/01-lateral-coordination/README.md)
(clone the repo). `cotal up` enables **JWT auth by default**; `--open` runs the unauthenticated
dev mesh used here — see [architecture](docs/architecture.md) → *Identity & authorization*.

## Run real Claude agents — one command

The CLI above runs bare peers. To run a team of **real Claude Code agents**, from inside a
[cmux](https://cmux.com) terminal:

```bash
cotal cmux go --space dev    # run from inside a cmux pane
```

That single command installs the Cotal plugin if needed (so Claude sessions get the
`cotal_*` tools), starts the mesh, opens the manager in its own tab, and opens a
workspace with the live console plus a **driving session**. Switch to that pane and
use `cotal_persona` / `cotal_spawn` / `cotal_despawn` to build your team. Re-running
it is idempotent.

No cmux? Use the plain terminal runtime: `cotal up --open` ·
`cotal supervise --space dev` · `cotal spawn me --space dev` (watch agents with
`cotal attach --name <n>`). For a fully scripted end-to-end demo, see
[`examples/02-cmux-handoff`](examples/02-cmux-handoff/README.md).

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

A pnpm + TypeScript ESM monorepo, four tiers with one-way deps —
`examples → implementations → packages ← (peer) extensions`:

- **`packages/*`** — the **protocol** (the standard): `@cotal-ai/core` (endpoint, subjects,
  types, the extension registry).
- **`extensions/*`** — **pluggable adapters** that peer-depend on core and self-register
  through its registry: `@cotal-ai/connector-core` (the shared MCP-bridge runtime — mesh agent
  + `cotal_*` tools incl. `cotal_spawn` + hook relay), `@cotal-ai/connector-claude-code`,
  `@cotal-ai/connector-codex`, and `@cotal-ai/connector-opencode` (thin adapters over it), and
  `@cotal-ai/cmux` (a driver over the cmux CLI plus the self-registering `cmux` runtime).
- **`implementations/*`** — **opinionated surfaces** over core: `@cotal-ai/cli` (`cotal` —
  `up`/`join`/`watch`/`console`/`web`/`spawn`/`mint`) and `@cotal-ai/manager` (the agent
  supervisor — `start`/`stop`/`ps`/`attach`, spawning through a `pty`/`tmux`/`cmux` runtime).
- **`examples/*`** — **use-cases** (composition roots). An example only configures +
  orchestrates and picks which extensions to register; it never adds message kinds,
  subjects, or endpoint methods — those go into `core`, generalized.

See [CLAUDE.md](CLAUDE.md) and [architecture](docs/architecture.md) for the full breakdown.

```bash
pnpm cotal <cmd>   # up, join, watch, console, web, spawn, setup, purge,
                   # supervise, cmux (cmux go), start, stop, ps, attach
pnpm smoke         # non-interactive end-to-end check against a running mesh
pnpm typecheck     # tsc --noEmit across all packages
pnpm build         # tsc build across all packages
```

## Where to go next

- **Run your own agent team** → [`cotal cmux go`](#run-real-claude-agents--one-command).
- **See real agents coordinate** → [`examples/02-cmux-handoff`](examples/02-cmux-handoff/README.md):
  four Claude Code agents ship one change across three repos from a single human prompt.
- **All addressing modes, by hand** → [`examples/01-lateral-coordination`](examples/01-lateral-coordination/README.md).
- **Build your own agent** → [agent frameworks](docs/agent-frameworks.md) or
  [Claude Code integration](docs/claude-code-integration.md).
- **Understand the protocol** → [architecture](docs/architecture.md), then
  [`packages/core/src`](packages/core/src).

## FAQ

- **`nats-server: command not found`** — install it (see Quick start). Cotal speaks to it
  over `127.0.0.1:4222`; the CLI doesn't bundle the server.
- **Do I need auth?** — not for local dev. `cotal up --open` runs an unauthenticated mesh;
  plain `cotal up` mints JWT creds. See [architecture](docs/architecture.md) →
  *Identity & authorization*.

## License

Apache-2.0 — see [LICENSE](LICENSE). The reasoning is in [LICENSING.md](LICENSING.md).
