# Example 02 — Orchestrated handoff in cmux

**Real Claude Code agents** coordinate over the Cotal mesh to ship one change across three repos.
You start with just a console + an **orchestrator**; the human types **one** prompt and the
orchestrator **spawns** todo-api / todo-web / todo-docs into their own [cmux](https://cmux.com)
tabs, fans the work out in parallel, and routes the API→web handoff itself — no second human prompt.

> Ported from the haa demo (A2A-over-MQTT) onto Cotal/NATS. The story is identical; the
> transport and the agent wiring are Cotal's.

```
              orchestrator
             /     |      \         (cotal_dm — fan out 3 tasks)
        todo-api todo-web todo-docs
            ↑↓       │
            └────────┘                (web ↔ api: sync the /tasks contract directly — peer-to-peer)
```

## What it shows

- **Real agents as lateral peers** — cmux runs the parallel sessions; Cotal is the layer that
  lets them actually talk to each other (presence + direct messages), which cmux alone doesn't.
- **Spawn on demand** — nothing is pre-opened but the orchestrator; it `cotal_spawn`s each worker
  into its own tab (a real coder, repo + `CLAUDE.md`), not a pre-arranged grid.
- **Human → agent → agent** — one prompt to the orchestrator; the rest is agent-to-agent.
- **Automatic handoff** — the orchestrator watches its inbox and routes `todo-api` → `todo-web`
  with no human in the loop.
- **Lateral peer coordination** — `todo-web` syncs the exact `/tasks` contract with `todo-api`
  **directly** over the mesh (no orchestrator hop) — the point of a flat space vs an orchestrator tree.

## The cast

| Pane | `COTAL_NAME` | Repo | Job |
|---|---|---|---|
| orchestrator | `orchestrator` | (none) | dispatch + route handoffs |
| todo-api | `todo-api` | `todo-api/` | add `priority` to the API |
| todo-web | `todo-web` | `todo-web/` | add the priority UI; then connect the real API |
| todo-docs | `todo-docs` | `todo-docs/` | document `priority` |

Each repo starts with `TODO(demo)` markers where the work lands. The orchestrator is the only pane
you open; it spawns the three workers (each via `run-agent.sh <role>` in its own tab). Identity is
set purely by the `COTAL_*` env on each launch line — both the MCP server and the presence hooks
inherit it. The role contract for each agent lives in its folder's `CLAUDE.md`.

## Prerequisites

- **Repo deps** — from the repo root: `pnpm install` (Node ≥ 20 + pnpm).
- **NATS** — macOS: `brew install nats-server`; other platforms: [nats.io/download](https://nats.io/download/).
  The launcher starts the mesh for you.
- **cmux** — `brew install --cask cmux` if you don't have it ([cmux.com](https://cmux.com)).
- **Run from inside cmux** — the launcher drives cmux over its socket, so it must run from a
  cmux terminal; outside one it exits with `✗ can't reach cmux`. Open this folder as the cmux
  workspace so it picks up `cmux.json`.
- **No plugin install** — each agent loads the Cotal MCP server (`cotal_*` tools) and the
  presence/inbox hooks directly via `--mcp-config` / `--settings` (see `run-agent.sh`).

## Run it

From **inside a cmux terminal**, with this folder open as the workspace:

1. **Open the workspace.** This starts the mesh, a `cotal-manager` tab (which spawns workers),
   and a `cotal-todo` workspace split into the console + orchestrator:

   ```bash
   ./launch.sh --drive
   ```

   > Every pane command is wrapped in `bash -lc '…'` on purpose: cmux launches panes in your
   > default login shell (here, **nushell**), which doesn't understand `&&` or inline
   > `VAR=val cmd` env prefixes — so the body runs in bash regardless.

   ```
   ┌───────────────┐
   │ cotal console │   live agent panel + message log
   ├───────────────┤
   │ orchestrator  │   claude — give it the one prompt
   │   (claude)    │
   └───────────────┘
   ```

2. **Accept the channels prompt.** The first time each pane starts, claude asks to
   *"load development channels?"* — **accept it**, or the channel that wakes idle panes stays off.

3. **Give the orchestrator the one goal.** On boot it onboards you and shows the example goal,
   then waits. Paste:

   > We're adding task priority to the app. priority: low | medium | high, default medium.
   > Add it to the API, the web UI, and the docs. Work in parallel. Tell me when each is done.

That's it — the orchestrator does the rest. The workers land in fresh, unfocused tabs (each a
real coder `cd`'d into its repo).

Prefer to drive it by hand? Plain `./launch.sh` (no flag) just verifies the mesh and prints the
cmux launch sequence — the workspace layout line plus the per-role command you can paste into a
plain terminal or trigger from the **command palette** (`cmux.json`). Each runs
`run-agent.sh <role>`, which `cd`s into the role's repo and starts claude wired to the mesh:

```bash
./run-agent.sh orchestrator   # → claude with the cotal MCP server, hooks, and channel push
```

## What you'll see

1. The orchestrator `cotal_spawn`s `todo-api`, `todo-web`, `todo-docs` — three new tabs open
   (unfocused) and fill in on the dashboard. It polls `cotal_roster` until all three are present.
2. It `cotal_dm`s each a task; cmux rings the tabs as messages land. Each worker drains its inbox,
   does the work in its own repo, and `cotal_dm`s back `done: …`.
3. The orchestrator sees `todo-api`'s `done:` and **automatically** messages `todo-web`:
   "remove the mock, connect the real `/tasks` endpoint." (The money shot.)
4. **Lateral handoff:** `todo-web` `cotal_dm`s `todo-api` *directly* for the exact `/tasks` shape
   and priority field; `todo-api` replies directly — the orchestrator isn't in this exchange.
   `todo-web` wires the real `fetch` from the answer.
5. `todo-web` reports done. The orchestrator tells you it's complete.

## How it maps to Cotal

The agents do all of this through the `cotal_*` MCP tools:

| What an agent does | Cotal tool |
|---|---|
| spawn a worker into its own tab | `cotal_spawn` |
| see who's on the mesh (discover) | `cotal_roster` |
| send a direct message | `cotal_dm(to, text)` |
| read its inbox | `cotal_inbox` |
| set its presence state | `cotal_status` |

The role contracts that tell each agent *how* to use these live in each folder's `CLAUDE.md`.

## Troubleshooting

- **`✗ can't reach cmux`** — you're not in a cmux terminal. cmux's control socket rejects
  detached callers; open a cmux terminal (with this folder as the workspace) and re-run.
- **A worker ignores a message** — channel push is off (you skipped the "load development
  channels" prompt). The message still arrived; press Enter in that pane to let it act, or
  restart the pane and accept the prompt.
- **Mesh didn't come up** — check `.mesh.log` in this folder. Usual cause: `nats-server` not
  installed, or port 4222 already taken.
- **Duplicate entries in the roster** — a stray manager from a previous run is still up. Run
  `./launch.sh --stop` to clear it, then re-launch.

## Notes & limits

- **Channel push** (`--dangerously-load-development-channels server:cotal`, set in
  `run-agent.sh`) wakes an idle worker the moment a peer messages it. It's research-preview
  gated, so claude shows a one-time confirmation per pane — accept it. If you don't (or it's
  off), messages still arrive; the worker just acts on them on its next turn (press Enter).
- The `--drive` path uses `cmux new-workspace --layout`; tweak the split in `launch.sh`'s
  `build_layout`. Spawned workers open via the manager in the `cotal-manager` tab, which launches
  each through `run-agent.sh` (see `src/manager.ts`).
- Agents only touch their own repo (the contracts forbid reaching into peers') — coordination
  happens over the mesh, not the filesystem.

When you're done, stop the manager with `./launch.sh --stop` (or just close its tab), and the mesh
with `Ctrl-C` in the `pnpm cotal up` process (or `pkill -f nats-server`).
