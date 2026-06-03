# Swarl

> Write the name as **Swarl**, not "SWARL" (the directory is all-caps, the name isn't).

A standard wire interface for software — especially AI agents — to coordinate in real
time as **lateral peers in a shared pub/sub space**, not as nodes in an orchestrator
tree. The wire contract (subjects, message schemas, presence/discovery conventions)
*is* the standard; libraries are thin clients over it. Transport is **NATS + JetStream**;
reference implementation is **TypeScript**.

See [docs/OVERVIEW.md](docs/OVERVIEW.md) for *what* it does and
[docs/architecture.md](docs/architecture.md) for *how*.

## Layout

pnpm + TypeScript ESM monorepo (`packages/*`, Node ≥20):

- **@swarl/core** — endpoint, subjects, message types; the NATS client layer.
- **@swarl/manager** — agent supervisor + control plane (spawns/manages nodes).
- **@swarl/connector** — MCP bridge (`@modelcontextprotocol/sdk`, zod).
- **@swarl/cli** — `swarl` commands: `up`, `join`, `manager`, `control`, `watch`.

## Commands

```bash
pnpm swarl <cmd>   # run the CLI (tsx packages/cli/src/index.ts)
pnpm smoke         # core smoke test
pnpm typecheck     # tsc --noEmit across all packages
pnpm build         # tsc build across all packages
```

## Current focus: Demo 1

We are building **Demo 1** — a showcase of what Swarl can do: role-specialized endpoints
join one shared space and coordinate laterally (presence, all three addressing modes,
live state, observability, graceful leave, late join) on a local NATS/JetStream mesh.
Today it's the **walking skeleton** (manual CLI peers); coding-agent adapters and the
control plane land next. Keep work aimed at making Demo 1 demonstrable — see
[docs/DEMO.md](docs/DEMO.md).

## Working on features

When implementing a feature, **always research online first** (NATS/JetStream APIs,
MCP SDK, A2A/SLIM conventions, etc.) before replying or writing code — verify current
behavior against real docs rather than relying on memory.

## Conventions

- ESM only (`"type": "module"`); run TS directly with `tsx`, no build step needed for dev.
- Core primitives: endpoint, agent node, space, channel, direct message, presence, history.
- Delivery modes (SLIM-inspired): multicast / unicast / anycast.
