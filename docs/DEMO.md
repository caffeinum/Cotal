# Swarl — First Demo

Role-specialized endpoints join **one shared space** and coordinate **laterally** —
presence, addressing, and messaging — on a local NATS/JetStream mesh, each participant
in its own terminal.

It's **configurable, not hardwired**: Swarl provides the primitives (addressability,
presence, a control plane, data sharing); the *topology* — who's "planner" vs "reviewer",
who delegates to whom — is just how you set it up.

> **Status:** this is the **walking skeleton** — manual CLI participants stand in for the
> agents. The coding-agent adapters (Claude Code + Codex via hooks/MCP) and the control
> plane land next. What's below runs today.

## What it demonstrates

- **Join in one command** — an endpoint joins a space and appears in presence.
- **Presence & discovery** — see who's present, their role, and live state
  (`idle` / `waiting` / `working` / `offline`).
- **Addressability** — all three delivery modes: **multicast** (broadcast to a channel),
  **unicast** (DM one peer), and **anycast** (reach *any one* of a role).
- **Live state** — watch a peer flip to `working` / `waiting` and back.
- **Observability** — a read-only `watch` endpoint tails everything on the mesh.
- **Graceful leave / drop** — a peer that quits (or whose heartbeat lapses) shows `offline`.
- **Late join** — a peer joining late immediately sees the current roster (presence snapshot).

## Prerequisites

- Node ≥ 20, pnpm, and `nats-server` (v2.11+). macOS: `brew install nats-server`.
- Install deps once, from the repo root: `pnpm install`.

## Run it

**1. Start the mesh** (one terminal — stays running):

```
pnpm swarl up
```

If a nats-server is already listening on `:4222`, Swarl detects it and reuses it.

**2. Join as a few peers** (one terminal each):

```
pnpm swarl join --space demo --name alice --role planner
pnpm swarl join --space demo --name bob   --role builder
pnpm swarl join --space demo --name carol --role reviewer
```

**3. Watch everything** (optional — one terminal):

```
pnpm swarl watch --space demo
```

## Next: a Claude Code agent joins as a peer

*(adapter lands next — documented here so the target flow is concrete)*

A real coding agent joins through the **manager** — you ask it to start an agent and it does
the native launch (in a terminal pane):

```
swarl role new builder                       # scaffold .swarl/roles/builder.md once
swarl start --role builder --name dave        # CLI → control → manager spawns a native claude
```

The manager runs the *real* `claude` with the plugin + identity in the env — an ordinary
Claude Code terminal, no wrapper in front. The plugin's MCP server reads the env at spawn and
auto-joins; `SWARL_ROLE` resolves the **role template** (`.swarl/roles/builder.md` — card +
optional persona + channel/policy defaults), so the role's richness lives in a file. (One-time:
`/plugin install swarl@swarl-mesh`.)

From there the agent is a peer like any other: it appears in
`/who`, its presence flips `working` / `idle` from lifecycle hooks, and
mesh messages reach it two ways — **deterministic hook injection** at turn boundaries (the
spine) and an async **channel** push that wakes it when idle. It talks back to the mesh with
the `swarl_publish` tool. See [architecture.md](architecture.md) for the surface mapping and
the accepted limits (no mid-turn interrupt in attach mode; channel push is research-preview
gated).

## Inside a `join` session

Type a line to broadcast it to the channel. Commands:

| Command | Effect |
|---|---|
| `/who` | show the roster (names, roles, states) |
| `/dm <name> <msg>` | unicast a direct message to one peer |
| `/anycast <role> <msg>` | anycast — reach *any one* instance of a role |
| `/working [what]` | set your state to `working` (+ optional activity) |
| `/waiting [why]` | set your state to `waiting` |
| `/idle` | set your state to `idle` |
| `/me <activity>` | update your activity text |
| `/quit` | leave (others see you go `offline`) |

## A scripted run-through

1. Join as `alice` and `bob` in two terminals — each sees the other join.
2. `alice`: type `kicking off the auth refactor` → `bob` sees it on `#general`.
3. `alice`: `/working auth refactor` → `bob`'s roster shows `alice ● working`.
4. `bob`: `/dm alice on it — taking the tests` → `alice` gets a direct message.
5. A late `carol` (reviewer) joins → immediately sees the current roster.
6. `alice`: `/anycast reviewer take a look at the diff` → exactly one reviewer (carol) gets it.
7. Quit `bob` (`/quit` or Ctrl-C) → `alice` sees `← bob went offline`.

## Quick self-test

```
pnpm smoke
```

Runs a non-interactive end-to-end check against a running mesh: two endpoints exchange a
broadcast and a DM, observe a `working` state change, and detect `offline` on leave.
