# Example 02 — the self-improving console

**A Cotal swarm rebuilds Cotal's own console.** Four real Claude Code agents join one
mesh space and coordinate **as lateral peers** to ship a polished, lazygit-style
**Ink/React TUI** for the live `console` — shipped as the new `cotal console-ink`
command. Built for **WeaveHacks 4 — Multi-Agent Orchestration** (W&B): agents that work
together, improving the very system that coordinates them.

```
                 orchestrator
                /     |      \           (cotal_dm — dispatch)
         research  backend  tui-designer
                      \______/             (backend ↔ tui-designer settle the
                                            useMesh() contract directly — peer-to-peer)
            research ──broadcast──▶ team   (SPEC ready, context for everyone)
```

## The cast

| Pane (`COTAL_NAME`) | Works in | Job |
|---|---|---|
| `orchestrator` | repo root | spawn the team, dispatch, route — never relays the technical contract |
| `research` | `research/` | read `INPUT.md`, verify, write `…/console/SPEC.md`, **broadcast** it to the team |
| `backend` | `implementations/cli` | `useMesh()` data layer over the existing `CotalEndpoint` observer |
| `tui-designer` | `implementations/cli` | the Ink TUI (panels, tabs, focus, `?` help) + the `console-ink` command |

The point: the **detail-level coordination is peer-to-peer**. `backend` and `tui-designer`
settle the `useMesh()` interface directly over the mesh; `research` broadcasts context to all.

## What it builds
`cotal console-ink` — an Ink rebuild of the hand-rolled ANSI dashboard
(`implementations/cli/src/render.ts`), rendering over the **existing** read-only
`CotalEndpoint` observer (never a new NATS client). Roster + channel tabs + live feed +
focus + context `?` help.

## Run it (on stage — cmux)
From inside a cmux terminal:
```bash
./launch.sh --drive    # mesh + a workspace: live console on top, orchestrator below
```
Give the orchestrator the goal in [`GOAL.md`](./GOAL.md); it spawns the three workers into
their own tabs and dispatches. Watch the swarm rebuild the console live — through the old console.

## Run it (overnight — headless self-optimizing loop)
`harness/run-once.sh <iter>` runs the whole swarm **headless** (PTY runtime, throwaway git
worktree, unique space), captures all mesh traffic to `transcript.jsonl`, then
`harness/evaluate.ts` judges it: **build green AND genuine peer-to-peer comms**. The loop
runs it repeatedly, applies one setup fix per iteration, and journals to `ITERATIONS.md`.
See the plan and `ITERATIONS.md`.
