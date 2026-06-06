#!/usr/bin/env bash
# Launch a `claude` session as a Swarl mesh peer from a local agent file — no manager.
#
#   scripts/join-claude.sh <name-or-path> [--space <s>] [--server <url>]
#
# <name-or-path> resolves to .swarl/agents/<name>.md (or an explicit path). The
# frontmatter is the agent's identity; the Markdown body is its persona.
# Prereqs: mesh up (`pnpm swarl up`) and the plugin installed once:
#   claude plugin install swarl@swarl-mesh --scope local
#
# Thin wrapper over scripts/spawn.ts so the launch recipe lives in one place
# (the connector's buildLaunch), not duplicated in shell.
set -euo pipefail
exec pnpm tsx "$(dirname "$0")/spawn.ts" "$@"
