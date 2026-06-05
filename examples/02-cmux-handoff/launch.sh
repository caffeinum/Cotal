#!/usr/bin/env bash
# Bring up the Swarl mesh and lay out the agents in cmux.
#
#   ./launch.sh           verify the mesh, print the cmux launch sequence
#   ./launch.sh --drive   open ONE cmux workspace, split into the demo layout
#
# Layout (one workspace, four claude panes + the live console dashboard):
#
#   ┌───────────────┬───────────────┐
#   │ swarl console │   todo-api    │
#   ├───────────────┤───────────────┤
#   │ orchestrator  │   todo-web    │
#   │   (claude)    ├───────────────┤
#   │               │   todo-docs   │
#   └───────────────┴───────────────┘
#
# Each agent's identity is set purely by the SWARL_* env on its launch line.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SPACE="todo"

# cmux is driven through the @swarl/cmux integration's CLI — no raw `cmux` here.
CMUX="$REPO_ROOT/node_modules/.bin/tsx $REPO_ROOT/extensions/cmux/src/cli.ts"
cmux_check() {
  $CMUX check || { echo "✗ can't reach cmux — run this from inside a cmux terminal." >&2; exit 1; }
}

# Start the headless manager (cmux spawn mode) once — skip if one is already running,
# so re-runs / using both --drive and --spawn don't leave duplicate managers in the roster.
manager_up() {
  if pgrep -f "swarl manager --space $SPACE" >/dev/null; then
    echo "✓ manager already running (log: $HERE/.manager.log)"
  else
    echo "starting the manager headless (cmux spawn mode) so agents can grow the team…"
    ( cd "$REPO_ROOT" && nohup pnpm swarl manager --space "$SPACE" --spawn cmux \
        >"$HERE/.manager.log" 2>&1 & )
    sleep 1
  fi
}

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

# role → name (name doubles as the agent's SWARL_ROLE here)
ROLES=("orchestrator" "todo-api" "todo-web" "todo-docs")

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

# The whole-workspace split layout (see the diagram at the top).
build_layout() {
  local left right
  left="$(printf '{"direction":"vertical","split":0.4,"children":[%s,%s]}' \
    "$(term "bash -lc 'cd $REPO_ROOT && pnpm swarl console --space $SPACE'")" \
    "$(agent_term orchestrator)")"
  right="$(printf '{"direction":"vertical","split":0.34,"children":[%s,{"direction":"vertical","split":0.5,"children":[%s,%s]}]}' \
    "$(agent_term todo-api)" "$(agent_term todo-web)" "$(agent_term todo-docs)")"
  printf '{"direction":"horizontal","split":0.5,"children":[%s,%s]}' "$left" "$right"
}

# --- spawn demo ------------------------------------------------------------
# The "left side first" flow: open ONLY the dashboard + the spawner, run the
# manager headless (cmux spawn mode), then ask the spawner to spin up workers —
# each opens as its own fresh cmux tab. Run FROM a cmux terminal.
if [[ "${1:-}" == "--spawn" ]]; then
  cmux_check
  manager_up
  left="$(printf '{"direction":"vertical","split":0.4,"children":[%s,%s]}' \
    "$(term "bash -lc 'cd $REPO_ROOT && pnpm swarl console --space $SPACE'")" \
    "$(agent_term spawner)")"
  echo "opening the left column (dashboard + spawner)…"
  $CMUX open swarl-spawn "$left"
  echo "✓ opened. In the spawner pane, ask it to spin up a couple of workers —"
  echo "  e.g. \"spin up two workers and say hi to each\". (manager log: $HERE/.manager.log)"
  exit 0
fi

# --- drive cmux ------------------------------------------------------------
# Opens ONE cmux workspace, split into the demo layout. Run this FROM a cmux
# terminal (the CLI talks to cmux over its Unix socket).
if [[ "${1:-}" == "--drive" ]]; then
  cmux_check
  manager_up
  echo "opening the swarl-todo workspace (console + orchestrator | api/web/docs)…"
  $CMUX open swarl-todo "$(build_layout)"
  echo "✓ workspace opened. Approve the plugin in each claude pane if prompted,"
  echo "  then give the orchestrator pane the human prompt (see below / README)."
  echo "  If the orchestrator needs another teammate it can swarl_spawn one — it opens"
  echo "  in its own tab. (manager log: $HERE/.manager.log)"
  exit 0
fi

# --- print the sequence ----------------------------------------------------
cat <<EOF

Mesh is up. Easiest: re-run with --drive (from inside a cmux terminal) to open
ONE workspace split into the demo layout — console + orchestrator on the left,
the three subagents on the right:

  ./launch.sh --drive

That opens the workspace via the @swarl/cmux driver (here's the layout if you
want to tweak it):

  tsx extensions/cmux/src/cli.ts open swarl-todo '$(build_layout)'

…or open plain terminals / use the cmux.json palette, one of these per pane:

EOF
i=1
for r in "${ROLES[@]}"; do
  printf "  P%d  %s\n" "$i" "$(launch_cmd "$r")"
  i=$((i + 1))
done
cat <<EOF

Each pane loads the Swarl MCP server + hooks and turns on channel push (so an
idle worker wakes when a peer messages it) — no plugin install needed. The first
time, accept claude's "load development channels?" prompt in each pane.

Then, in the orchestrator pane, give it the one human prompt:

  "We're adding task priority to the app. priority: low | medium | high,
   default medium. Add it to the API, the web UI, and the docs. Work in
   parallel. Tell me when each is done."

Watch the orchestrator fan out three tasks, then auto-route the api→web
handoff — no second human prompt. Full runbook: README.md.
EOF
