#!/usr/bin/env bash
# Launch a CODEX (OpenAI) reviewer as a cross-vendor peer on the Cotal mesh.
#
#   run-codex.sh <name> [role]
#
# Non-interactive: `codex exec "<contract>"` with the cotal MCP server injected via -c
# overrides (mirrors extensions/connector-codex/src/extension.ts), autonomous
# (approval_policy=never), so it joins the mesh, reviews on disk, and posts findings via
# the cotal_* tools — no human in the loop. Read-only by contract (it comments, never edits).
set -uo pipefail

name="${1:-codex-reviewer}"
role="${2:-codex-reviewer}"

REPO="$(git rev-parse --show-toplevel)"
HERE="$REPO/examples/04-self-improving-console"
TSX="$REPO/node_modules/.bin/tsx"
MCP="$REPO/extensions/connector-codex/src/mcp.ts"
SPACE="${COTAL_SPACE:-console}"
SERVER="${COTAL_SERVERS:-nats://127.0.0.1:4222}"

# Review on disk at the canonical paths (SPEC + console code live here).
cd "$REPO"

PROMPT="$(cat "$HERE/agents/codex-reviewer.md")
You are \"$name\" (role $role) on the cotal mesh, space \"$SPACE\". Use cotal_status to announce presence, then proceed."

exec codex exec "$PROMPT" \
  -c "mcp_servers.cotal.command=\"$TSX\"" \
  -c "mcp_servers.cotal.args=[\"$MCP\"]" \
  -c "mcp_servers.cotal.default_tools_approval_mode=\"auto\"" \
  -c "mcp_servers.cotal.env.COTAL_SPACE=\"$SPACE\"" \
  -c "mcp_servers.cotal.env.COTAL_NAME=\"$name\"" \
  -c "mcp_servers.cotal.env.COTAL_ROLE=\"$role\"" \
  -c "mcp_servers.cotal.env.COTAL_SERVERS=\"$SERVER\"" \
  -c "approval_policy=\"never\"" \
  -c "sandbox_mode=\"workspace-write\""
