#!/usr/bin/env bash
# harness/run-once.sh <iter> — run the console-rebuild swarm HEADLESS, once, in isolation.
#
# - fresh git worktree of the demo branch under .runs/run-<iter>  (throwaway)
# - unique mesh space console-r<iter>  (no cross-run stream collisions)
# - NATS in OPEN mode so the observer can see DMs (peer-to-peer visibility)
# - manager on the PTY runtime (auto-confirms claude's dev-channels prompt)
# - orchestrator launched under a PTY (`script`) so the TUI has a terminal; it
#   cotal_spawns research/backend/tui-designer via the manager
# - observer logs ALL traffic to <rundir>/transcript.jsonl
# - waits for "DEMO COMPLETE" / orchestrator exit / timeout, then tears down and evaluates
#
# Prints the verdict JSON path. Does NOT delete the worktree (the caller inspects + cleans up).
set -uo pipefail

ITER="${1:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EX="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$EX/../.." && pwd)"
BRANCH="${COTAL_BRANCH:-demo/weavehacks-console-tui}"
SPACE="console-r$ITER"
RUNDIR="$REPO/.runs/run-$ITER"
SERVER="${COTAL_SERVERS:-nats://127.0.0.1:4222}"
TIMEOUT="${RUN_TIMEOUT:-900}"
TSX="$REPO/node_modules/.bin/tsx"
EXREL="examples/04-self-improving-console"

log() { echo "[run-once $ITER] $*"; }

# --- fresh worktree -------------------------------------------------------
mkdir -p "$REPO/.runs"
git -C "$REPO" worktree remove --force "$RUNDIR" 2>/dev/null || true
rm -rf "$RUNDIR"
git -C "$REPO" worktree add --force --detach "$RUNDIR" "$BRANCH" || { log "worktree add failed"; exit 2; }
log "worktree at $RUNDIR"

# worktrees have no node_modules — install (warm pnpm store makes this quick)
( cd "$RUNDIR" && pnpm install --prefer-offline ) >"$HERE/.install-$ITER.log" 2>&1 || { log "pnpm install failed (see .install-$ITER.log)"; }

# --- NATS (open mode so DMs are observable) -------------------------------
nats_up() { (exec 3<>/dev/tcp/127.0.0.1/4222) 2>/dev/null; }
if ! nats_up; then
  log "starting NATS (open mode)"
  ( cd "$REPO" && nohup pnpm cotal up --open --store-dir "$RUNDIR/.nats" >"$HERE/.mesh-$ITER.log" 2>&1 & )
  for _ in $(seq 1 40); do nats_up && break; sleep 0.25; done
fi
nats_up || { log "NATS did not come up"; exit 3; }

TRANSCRIPT="$RUNDIR/transcript.jsonl"
: > "$TRANSCRIPT"

# --- observer (all traffic -> transcript) ---------------------------------
COTAL_SPACE="$SPACE" COTAL_SERVERS="$SERVER" TRANSCRIPT="$TRANSCRIPT" \
  "$TSX" "$RUNDIR/$EXREL/harness/observer.ts" >"$HERE/.observer-$ITER.log" 2>&1 &
OBS=$!

# --- manager (pty runtime, from the worktree) -----------------------------
# COTAL_HEADLESS=1 in the manager env → every agent it spawns (orchestrator + the
# workers it cotal_spawns) inherits headless mode. The PTY runtime gives each a real
# pty with an OPEN stdin (so claude doesn't EOF-exit) and auto-confirms dev-channels.
COTAL_HEADLESS=1 COTAL_SPACE="$SPACE" COTAL_SERVERS="$SERVER" COTAL_RUNTIME=pty \
  "$TSX" "$RUNDIR/$EXREL/src/manager.ts" >"$HERE/.manager-$ITER.log" 2>&1 &
MGR=$!
sleep 4

# --- orchestrator: ask the manager to spawn it (PTY runtime), not a fragile
#     `script` wrapper (which EOF-exits under nohup). It then cotal_spawns the workers.
COTAL_SPACE="$SPACE" COTAL_SERVERS="$SERVER" \
  "$TSX" "$RUNDIR/bin/cotal.ts" start --space "$SPACE" --server "$SERVER" \
    --name orchestrator --role orchestrator >"$HERE/.orch-start-$ITER.log" 2>&1 \
  || log "cotal start orchestrator failed (see .orch-start-$ITER.log)"
log "swarm running (space=$SPACE, timeout=${TIMEOUT}s) — mgr=$MGR obs=$OBS"

# --- wait for completion / exit / timeout ---------------------------------
deadline=$(( $(date +%s) + TIMEOUT ))
outcome="timeout"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -q "DEMO COMPLETE" "$TRANSCRIPT" 2>/dev/null; then outcome="complete"; break; fi
  sleep 5
done
log "outcome: $outcome"

# --- teardown (specific PIDs only; never broad-pkill claude) ---------------
kill "$MGR" 2>/dev/null || true      # manager's SIGTERM handler stops spawned agents
sleep 2
kill "$OBS" 2>/dev/null || true

# --- evaluate -------------------------------------------------------------
VERDICT="$RUNDIR/verdict.json"
"$TSX" "$RUNDIR/$EXREL/harness/evaluate.ts" "$RUNDIR" >"$VERDICT" 2>"$HERE/.evaluate-$ITER.log" || true
log "verdict -> $VERDICT"
cat "$VERDICT" 2>/dev/null || echo '{"green":false,"failureMode":"evaluate-failed"}'
echo "RUNDIR=$RUNDIR"
echo "OUTCOME=$outcome"
