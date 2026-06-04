#!/usr/bin/env bash
# Bring up the Swarl mesh and lay out the agents in cmux.
#
#   ./launch.sh           verify the mesh, print the cmux launch sequence
#   ./launch.sh --drive   open ONE cmux workspace, split into the demo layout
#
# Layout (one workspace, four claude panes + a mesh watcher):
#
#   ┌───────────────┬───────────────┐
#   │  swarl watch  │   todo-api    │
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
    "$(term "bash -lc 'cd $REPO_ROOT && pnpm swarl watch --space $SPACE'")" \
    "$(agent_term orchestrator)")"
  right="$(printf '{"direction":"vertical","split":0.34,"children":[%s,{"direction":"vertical","split":0.5,"children":[%s,%s]}]}' \
    "$(agent_term todo-api)" "$(agent_term todo-web)" "$(agent_term todo-docs)")"
  printf '{"direction":"horizontal","split":0.5,"children":[%s,%s]}' "$left" "$right"
}

# --- drive cmux ------------------------------------------------------------
# Opens ONE cmux workspace, split into the demo layout. Run this FROM a cmux
# terminal (the CLI talks to cmux over its Unix socket).
if [[ "${1:-}" == "--drive" ]]; then
  command -v cmux >/dev/null || { echo "✗ cmux not found on PATH" >&2; exit 1; }
  cmux ping >/dev/null 2>&1 || {
    echo "✗ can't reach cmux — run this from inside a cmux terminal." >&2; exit 1; }
  echo "opening the swarl-todo workspace (watch + orchestrator | api/web/docs)…"
  cmux new-workspace --name swarl-todo --focus true --layout "$(build_layout)"
  echo "✓ workspace opened. Approve the plugin in each claude pane if prompted,"
  echo "  then give the orchestrator pane the human prompt (see below / README)."
  exit 0
fi

# --- print the sequence ----------------------------------------------------
cat <<EOF

Mesh is up. Easiest: re-run with --drive (from inside a cmux terminal) to open
ONE workspace split into the demo layout — watcher + orchestrator on the left,
the three subagents on the right:

  ./launch.sh --drive

That runs this single command (here's the layout if you want to tweak it):

  cmux new-workspace --name swarl-todo --focus true --layout '$(build_layout)'

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
