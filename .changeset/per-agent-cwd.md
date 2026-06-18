---
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/core": minor
---

feat(manager): per-agent working directory (cwd)

Thread an optional `cwd` through every spawn path so different agents can be rooted
at different folders/repos instead of all sharing the manager's `workspaceRoot`.

- `cotal start --cwd <dir>` and the control-plane `start` op accept a working directory.
- The `cotal_spawn` MCP tool gains an optional `cwd` arg so an in-session agent can
  spawn a teammate into another repo.
- Roster entries accept a `cwd:` field for declarative boot.

A relative `cwd` resolves against the manager's workspace root. Backward compatible —
when omitted, agents keep launching at `workspaceRoot` exactly as before.
