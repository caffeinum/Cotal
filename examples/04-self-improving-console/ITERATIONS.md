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
| 1 | 🔴 RED | ok | none | no-traffic — orchestrator EOF-exited immediately | spawn orchestrator via manager PTY (`cotal start`) + manager headless; drop `script` |
| 2 | 🟡 partial | — | spawn+coordinate works | worktree isolation LEAKS — research wrote SPEC to MAIN, workers read worktree placeholder | switch harness to main + git-reset between runs; fix peer-to-peer metric (resolve `to` id→name) |

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

## Iteration 1 — first live run (🔴 RED)
**Verdict:** `{green:false, buildOk:true, peerToPeer:false, messages:0, failureMode:"no-traffic"}`,
outcome `orchestrator-exited`. Prereqs confirmed present: claude 2.1.161, nats-server 2.14.2,
node-pty (manager imports OK). The worktree + pnpm install + tsc path works (`buildOk:true`).

**Root cause:** the orchestrator was launched via `script -q /dev/null … run-agent.sh orchestrator`
under `nohup`, so claude got a **closed stdin → read EOF → exited instantly** (the `^D` in the log).
No agent ever joined → 0 messages.

**Fix applied (for iter 2):** stop using `script`. Run the manager with `COTAL_HEADLESS=1` and ask it
to spawn the orchestrator via the **PTY runtime** (`cotal start --name orchestrator`). node-pty gives
a real pty with an OPEN stdin (no EOF) and auto-confirms the dev-channels prompt; every agent the
manager spawns inherits headless mode. This makes the orchestrator and the workers boot identically.

**Next risks to watch:** does the orchestrator actually act on the GOAL init under the PTY runtime and
`cotal_spawn` the workers? Do the workers wake on its DMs? Is `DEMO COMPLETE` ever broadcast?

## Iteration 2 — orchestration works, isolation leaks (🟡 partial)
**What worked (big):** the manager spawned the orchestrator via PTY; the orchestrator booted, set
status, **`cotal_spawn`ed research + backend + tui-designer (all joined)**, and DM'd each a detailed
task. research read INPUT.md, verified the `@cotal/core` API against the code, and wrote a real
194-line SPEC; tui-designer's status went to "settling useMesh() shape with backend." So the core
mechanic — headless multi-agent spawn + dispatch + lateral intent — is proven.

**The blocker:** **worktree isolation does not hold.** research wrote the SPEC to the MAIN repo
(`/Users/user/Projects/cotal/implementations/cli/src/console/SPEC.md`, 194 lines) instead of its
worktree copy (still the 7-line placeholder) — agents resolve repo paths to the canonical project
location they know, not their `git worktree` cwd. Consequence: backend/tui-designer (cwd = worktree)
read the worktree's PLACEHOLDER SPEC, so the research→workers handoff is silently split. It also
pollutes the main tree uncontrollably — strictly worse than a controlled reset.

**Decision / fix for iter 3:** drop worktrees. Run the swarm on the **main demo branch**; reset the
console files with `git checkout` (+ scoped `git clean`) before each run and snapshot green output to
`reference/`. Unique space per run still isolates the mesh. Also fixed the **peer-to-peer metric**:
DM `to` is an instance id, so observer now logs `fromId` and evaluate resolves id→name (HUB =
orchestrator/manager/cli) so a worker's `done:`→orchestrator no longer counts as peer-to-peer.

**Caveat:** run-2's own verdict (worktree typecheck of placeholders) is not meaningful; iter 3 on
main is the first run that can fairly score build + peer-to-peer.
