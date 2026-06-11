# @cotal-ai/connector-opencode

## 0.1.1

### Patch Changes

- 246c9b9: Add the OpenCode connector. It launches a watchable `opencode` TUI bound to the agent's session — a headless `opencode serve` with the mesh plugin loaded, plus a foreground `opencode attach --session <id>` — drives that visible session via `session.promptAsync`, and renders the `cotal_*` tools as native plugin tools at Claude-Code parity. The tool surface is extracted into `cotalToolSpecs` in connector-core so the Claude/Codex MCP adapters and the OpenCode plugin render the same tools.
- Updated dependencies [246c9b9]
- Updated dependencies [246c9b9]
  - @cotal-ai/connector-core@0.1.3
