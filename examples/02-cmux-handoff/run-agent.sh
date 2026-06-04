#!/usr/bin/env bash
# Launch ONE demo agent as a Claude Code session wired into the Swarl mesh.
#
#   run-agent.sh <orchestrator|todo-api|todo-web|todo-docs>
#
# Loads the connector as a bare MCP server (swarl tools) + lifecycle hooks
# (presence + inbox drain), and turns on channel push so an idle pane wakes
# when a peer messages it. No plugin install / marketplace needed.
set -euo pipefail

role="${1:-}"
case "$role" in
  orchestrator | todo-api | todo-web | todo-docs) ;;
  *)
    echo "usage: run-agent.sh <orchestrator|todo-api|todo-web|todo-docs>" >&2
    exit 1
    ;;
esac

REPO="$(git rev-parse --show-toplevel)"
HERE="$REPO/examples/02-cmux-handoff"
CONN="$REPO/extensions/connector"
TSX="$REPO/node_modules/.bin/tsx"
CFG="$HERE/.swarl" # git-ignored (.swarl/)

# --- generate the MCP + hooks config (idempotent; absolute repo paths) ------
mkdir -p "$CFG"

cat >"$CFG/mcp.json" <<JSON
{
  "mcpServers": {
    "swarl": { "command": "$TSX", "args": ["$CONN/src/mcp.ts"] }
  }
}
JSON

# One hook entry, reused for every lifecycle event the connector cares about.
hook='{"hooks":[{"type":"command","command":"'"$TSX"'","args":["'"$CONN/src/hook.ts"'"]}]}'
cat >"$CFG/settings.json" <<JSON
{
  "hooks": {
    "SessionStart": [ $hook ],
    "UserPromptSubmit": [ $hook ],
    "Notification": [ {"matcher":"permission_prompt|elicitation_dialog","hooks":[{"type":"command","command":"$TSX","args":["$CONN/src/hook.ts"]}]} ],
    "Stop": [ $hook ],
    "StopFailure": [ $hook ],
    "SessionEnd": [ $hook ]
  }
}
JSON

# --- launch claude in the role's repo, wired to the mesh --------------------
cd "$HERE/$role"
exec env \
  SWARL_SPACE=todo SWARL_NAME="$role" SWARL_ROLE="$role" SWARL_CHANNEL=1 \
  claude \
    --strict-mcp-config \
    --mcp-config "$CFG/mcp.json" \
    --settings "$CFG/settings.json" \
    --dangerously-load-development-channels server:swarl
