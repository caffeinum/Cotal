# Example 02 — Orchestrated handoff in cmux

Four **real Claude Code agents**, one per [cmux](https://cmux.com) pane, coordinate over the
Swarl mesh to ship one change across three repos. The human types **one** prompt; the agents
discover each other, fan the work out in parallel, and route the API→web handoff themselves —
no second human prompt.

> Ported from the [haa](https://github.com/) demo (A2A-over-MQTT) onto Swarl/NATS. The story
> is identical; the transport and the agent wiring are Swarl's.

```
              orchestrator
             /     |      \         (swarl_dm — fan out 3 tasks)
        todo-api todo-web todo-docs
            |        ^
            └────────┘                (api done → orchestrator → web: "connect the real API")
```

## What it shows

- **Real agents as lateral peers** — cmux runs the parallel sessions; Swarl is the layer that
  lets them actually talk to each other (presence + direct messages), which cmux alone doesn't.
- **Human → agent → agent** — one prompt to the orchestrator; the rest is agent-to-agent.
- **Automatic handoff** — the orchestrator watches its inbox and routes `todo-api` → `todo-web`
  with no human in the loop.

## The cast

| Pane | `SWARL_NAME` | Repo | Job |
|---|---|---|---|
| orchestrator | `orchestrator` | (none) | dispatch + route handoffs |
| todo-api | `todo-api` | `todo-api/` | add `priority` to the API |
| todo-web | `todo-web` | `todo-web/` | add the priority UI; then connect the real API |
| todo-docs | `todo-docs` | `todo-docs/` | document `priority` |

Each repo starts with `TODO(demo)` markers where the work lands. Identity is set purely by the
`SWARL_*` env on each pane's launch line — both the MCP server and the presence hooks inherit it.

## One-time setup

1. **NATS** — `brew install nats-server` (the launcher starts it for you).
2. **cmux** — `brew install --cask cmux` if you don't have it. Open this folder as the cmux
   workspace so it picks up `cmux.json`.

No plugin install needed: each agent loads the Swarl MCP server (`swarl_*` tools) and the
presence/inbox hooks directly via `--mcp-config` / `--settings` (see `run-agent.sh`). The
**first time each pane starts**, claude asks to *"load development channels?"* — **accept it**,
or the channel that wakes idle panes stays off.

## Run it

From **inside a cmux terminal** (the cmux CLI talks to the app over its socket):

```bash
./launch.sh --drive    # starts the mesh, opens ONE workspace in the demo layout
```

That opens a single `swarl-todo` workspace, split like this:

```
┌───────────────┬───────────────┐
│  swarl watch  │   todo-api    │
├───────────────┤───────────────┤
│ orchestrator  │   todo-web    │
│   (claude)    ├───────────────┤
│               │   todo-docs   │
└───────────────┴───────────────┘
```

Left column: the mesh watcher (live traffic) on top, the **orchestrator** below. Right
column: the three subagents. Each pane `cd`s into its repo and starts `claude` with its
`SWARL_*` identity. The workspace opens as its own cmux tab — that tab *is* the container
holding the four panes. (If the columns/rows come out mirrored, swap `horizontal`/`vertical`
in `launch.sh`'s `build_layout`.)

> Every pane command is wrapped in `bash -lc '…'` on purpose: cmux launches panes in your
> default login shell (here that's **nushell**), which doesn't understand `&&` or inline
> `VAR=val cmd` env prefixes — so we run the body in bash regardless.

Plain `./launch.sh` (no flag) just verifies the mesh and prints the commands — including the
single `cmux new-workspace --layout …` line, and per-pane commands you can paste into plain
terminals or trigger from the **command palette** (`cmux.json`). Each pane just runs
`run-agent.sh <role>`, which `cd`s into the role's repo and starts claude wired to the mesh:

```bash
./run-agent.sh orchestrator   # → claude with the swarl MCP server, hooks, and channel push
```

Then, in the **orchestrator** pane, give it the one prompt:

> We're adding task priority to the app. priority: low | medium | high, default medium.
> Add it to the API, the web UI, and the docs. Work in parallel. Tell me when each is done.

## What you'll see

1. Orchestrator calls `swarl_roster`, confirms the three workers are present, and `swarl_dm`s
   each a task. cmux rings the other panes as messages land.
2. `todo-api`, `todo-web`, `todo-docs` each drain their inbox, do the work in their own repo,
   and `swarl_dm` back `done: …`.
3. The orchestrator sees `todo-api`'s `done:` and **automatically** messages `todo-web`:
   "remove the mock, connect the real `/tasks` endpoint." (The money shot.)
4. `todo-web` does the follow-up and reports done. The orchestrator tells you it's complete.

## Variant: spawn the team on demand (`--spawn`)

The static layout above launches everyone up front. The `--spawn` flow instead starts with
**just the left column** and grows the rest live:

```bash
./launch.sh --spawn     # mesh + manager (headless), then opens dashboard + spawner only
```

```
┌───────────────┐
│   dashboard   │   swarl console — live agent panel + message log
├───────────────┤
│   spawner     │   claude — talk to it here
│   (claude)    │
└───────────────┘
```

A **manager** runs headless in `cmux` spawn mode (log: `.manager.log`). Tell the spawner, e.g.:

> spin up two workers and say hi to each

The spawner calls `swarl_spawn` per worker → the manager opens a **new cmux pane** running a
`swarl join` peer → the spawner waits for each to appear in `swarl_roster`, then `swarl_dm`s it a
greeting. You watch new panes appear on the left and the dashboard panel fill in. (Spawning into a
pane is best-effort — same caveat as `--drive`; the workers here are generic mesh peers, not coders.)

## How it maps to Swarl

| haa | Swarl tool |
|---|---|
| `discover()` | `swarl_roster` |
| `send_message(target)` | `swarl_dm(to, text)` |
| `fetch_inbox()` | `swarl_inbox` |

The role contracts live in each folder's `CLAUDE.md`.

## Notes & limits

- **Channel push** (`--dangerously-load-development-channels server:swarl`, set in
  `run-agent.sh`) wakes an idle worker the moment a peer messages it. It's research-preview
  gated, so claude shows a one-time confirmation per pane — accept it. If you don't (or it's
  off), messages still arrive; the worker just acts on them on its next turn (press Enter).
- The `--drive` path uses `cmux new-workspace --layout`; if the columns/rows render mirrored,
  swap `horizontal`/`vertical` in `launch.sh`'s `build_layout`.
- Agents only touch their own repo (the contracts forbid reaching into peers') — coordination
  happens over the mesh, not the filesystem.

When you're done, stop the mesh with `Ctrl-C` in the `pnpm swarl up` process (or
`pkill -f nats-server`).
