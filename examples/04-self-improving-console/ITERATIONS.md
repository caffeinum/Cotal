# Iterations journal — self-improving-console harness

The overnight `/loop` runs the swarm headless, evaluates it, applies ONE setup fix per
iteration, and logs the result here. **Green = build OK AND ≥1 genuine peer-to-peer DM.**
Stop after **2 greens in a row** or **15 iterations**.

What we tune: the *setup* — role contracts (`agents/*.md`), `GOAL.md`, `run-agent.sh`, the
harness. The console code the swarm emits is the test subject (thrown away each run in a
worktree under `.runs/`).

Run one iteration manually:
```bash
examples/04-self-improving-console/harness/run-once.sh <iter>
```

| Iter | Outcome | build | peer-to-peer (pairs) | failure mode | fix applied |
|------|---------|-------|----------------------|--------------|-------------|
| 0 | scaffold | n/a | n/a | — | Phase A built (see below) |

---

## Iteration 0 — Phase A scaffold (no swarm run yet)
**Status:** harness built and unit-verified; first LIVE swarm run pending (next loop fire).

Built and verified:
- Branch `demo/weavehacks-console-tui`; Ink plumbing in `@cotal/cli` (`ink@6.8`, `react@19.2`,
  `@inkjs/ui@2`), `jsx:react-jsx`, runnable placeholder `console-ink` command — `pnpm --filter
  @cotal/cli typecheck` GREEN.
- Console skeleton anchors (`implementations/cli/src/console/{mesh.ts,app.tsx,ui/,SPEC.md}`).
- Example-04 harness: `run-agent.sh` (4 roles, per-role cwd, contract via `--append-system-prompt`,
  headless mode), `src/manager.ts` (runtime from env; `confirm` set so the PTY runtime auto-accepts
  the dev-channels prompt), `launch.sh` (cmux), `cmux.json`, 4 role contracts, `GOAL.md`,
  `research/INPUT.md`, README.
- Autonomous harness: `harness/observer.ts` (logs ALL traffic incl. DMs via open-mode whole-space
  tap), `harness/run-once.sh` (worktree + open NATS + pty manager + pty orchestrator + wait + teardown),
  `harness/evaluate.ts` (build via worktree `tsc` + peer-to-peer comms analysis). Evaluator
  unit-tested on synthetic transcripts: correctly reports green/red and peer pairs.

**Key de-risk found:** the PTY runtime already auto-confirms claude's dev-channels prompt
(`implementations/manager/src/runtime/pty.ts` watches `spec.confirm` → presses Enter), so headless
agents wake on incoming DMs without cmux key-injection.

**Open risks for the first live run (expected early failure modes):**
- The orchestrator runs under `script` (a PTY) headless — does claude boot + act on the GOAL prompt
  with `--dangerously-skip-permissions` (and accept dev-channels) without a human? Unverified.
- Completion detection relies on the orchestrator broadcasting `DEMO COMPLETE`.
- Nested Claude Code sessions (a claude session spawning claude agents) — feasibility unverified.
