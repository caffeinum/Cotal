#!/usr/bin/env bash
# Bring up the Swarl mesh and lay out the demo in cmux.
#
#   ./launch.sh           verify the mesh, print the cmux launch sequence
#   ./launch.sh --drive   open the console + orchestrator; the orchestrator grows the team
#   ./launch.sh --stop    stop the manager(s) for this space
#
# Layout (one workspace: the live console dashboard + the orchestrator). The
# orchestrator spawns todo-api / todo-web / todo-docs into their own tabs on demand —
# nothing is pre-opened.
#
#   ┌───────────────┐
#   │ swarl console │   live agent panel + message log
#   ├───────────────┤
#   │ orchestrator  │   claude — give it the one prompt; it spawns the workers
#   │   (claude)    │
#   └───────────────┘
#
# Each agent's identity is set purely by the SWARL_* env on its launch line.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SPACE="todo"

TSX="$REPO_ROOT/node_modules/.bin/tsx"
# cmux is driven through the @swarl/cmux integration's CLI — no raw `cmux` here.
CMUX="$TSX $REPO_ROOT/extensions/cmux/src/cli.ts"
cmux_check() {
  $CMUX check || { echo "✗ can't reach cmux — run this from inside a cmux terminal." >&2; exit 1; }
}

# The manager spawns teammates into cmux tabs, so it must run inside a LIVE cmux pane —
# cmux's control socket (socketControlMode: cmuxOnly) rejects detached/headless callers.
# Open it in its own tab; skip if one's already running so re-runs don't stack managers.
# This is the example's own manager (src/manager.ts): its connector launches run-agent.sh,
# so each spawned tab is a real coder, not a bare `swarl join` peer.
manager_term() { # the example manager as a live pane, so its cmux spawns are authorized
  term "bash -lc 'cd $HERE && SWARL_SPACE=$SPACE exec $TSX $HERE/src/manager.ts'"
}
manager_up() {
  if pgrep -f "$HERE/src/manager.ts" >/dev/null; then
    echo "✓ manager already running"
  else
    echo "opening the manager in its own cmux tab so the orchestrator can grow the team…"
    $CMUX open swarl-manager "$(manager_term)"
  fi
}

# --- stop ------------------------------------------------------------------
# Cleanly stop the manager(s) for this space, so no orphaned one survives to
# duplicate the roster.
if [[ "${1:-}" == "--stop" ]]; then
  if pkill -f "$HERE/src/manager.ts"; then
    echo "✓ stopped manager(s) for space $SPACE"
  else
    echo "no manager running for space $SPACE"
  fi
  exit 0
fi

# --- mesh ------------------------------------------------------------------
nats_up() { (exec 3<>/dev/tcp/127.0.0.1/4222) 2>/dev/null; }

if nats_up; then
  echo "✓ NATS already up on 127.0.0.1:4222"
else
  command -v nats-server >/dev/null || {
    echo "✗ nats-server not found. Install it: brew install nats-server" >&2
    exit 1
  }
  echo "starting the mesh (pnpm swarl up) in the background…"
  ( cd "$REPO_ROOT" && nohup pnpm swarl up >"$HERE/.mesh.log" 2>&1 & )
  for _ in $(seq 1 20); do nats_up && break; sleep 0.25; done
  nats_up && echo "✓ mesh up (log: $HERE/.mesh.log)" || {
    echo "✗ mesh did not come up — see $HERE/.mesh.log" >&2; exit 1; }
fi

# cmux spawns panes in the user's login shell (nushell here), which doesn't
# speak `&&` or inline env prefixes — so every command runs via `bash -lc`.
# All claude flags/config live in run-agent.sh (single source of truth).
launch_cmd() { # $1 = role dir / name
  echo "bash -lc '$HERE/run-agent.sh $1'"
}

# A terminal leaf for the layout JSON. $1 = shell command (no embedded ").
term() { printf '{"pane":{"surfaces":[{"type":"terminal","command":"%s"}]}}' "$1"; }

# An agent leaf: claude wired to the mesh in its role dir. $1 = role/name.
agent_term() {
  term "bash -lc '$HERE/run-agent.sh $1'"
}

# The workspace layout: console dashboard on top, orchestrator below.
build_layout() {
  printf '{"direction":"vertical","split":0.4,"children":[%s,%s]}' \
    "$(term "bash -lc 'cd $REPO_ROOT && pnpm swarl console --space $SPACE'")" \
    "$(agent_term orchestrator)"
}

# --- drive cmux ------------------------------------------------------------
# Opens the console + orchestrator workspace. Run this FROM a cmux terminal
# (the CLI talks to cmux over its Unix socket).
if [[ "${1:-}" == "--drive" ]]; then
  cmux_check
  manager_up
  echo "opening the swarl-todo workspace (console + orchestrator)…"
  $CMUX open swarl-todo "$(build_layout)"
  echo "✓ workspace opened. Approve the plugin in the orchestrator pane if prompted,"
  echo "  then give it the human prompt (see below / README). It spawns todo-api/web/docs"
  echo "  into their own tabs and dispatches the work. (manager runs in the swarl-manager tab)"
  exit 0
fi

# --- print the sequence ----------------------------------------------------
cat <<EOF

Mesh is up. Easiest: re-run with --drive (from inside a cmux terminal) to open
the console + orchestrator. Give the orchestrator the one prompt and it spawns
todo-api / todo-web / todo-docs into their own tabs:

  ./launch.sh --drive

That opens the workspace via the @swarl/cmux driver (here's the layout if you
want to tweak it):

  tsx extensions/cmux/src/cli.ts open swarl-todo '$(build_layout)'

…or open plain terminals / use the cmux.json palette. Start the orchestrator with:

  $(launch_cmd orchestrator)

(todo-api/web/docs are spawned by the orchestrator — or launch any by hand with
run-agent.sh <role>.)

EOF
cat <<EOF
Each pane loads the Swarl MCP server + hooks and turns on channel push (so an
idle worker wakes when a peer messages it) — no plugin install needed. The first
time, accept claude's "load development channels?" prompt in each pane.

Then, in the orchestrator pane, give it the one human prompt:

  "We're adding task priority to the app. priority: low | medium | high,
   default medium. Add it to the API, the web UI, and the docs. Work in
   parallel. Tell me when each is done."

Watch the orchestrator spawn the three workers, fan out the tasks, then auto-route
the api→web handoff — no second human prompt. Full runbook: README.md.
EOF
