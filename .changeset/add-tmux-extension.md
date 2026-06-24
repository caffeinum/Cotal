---
"@cotal-ai/tmux": minor
"cotal-ai": minor
---

Add `@cotal-ai/tmux` — tmux Runtime and TerminalLayout extension.

Each agent spawned via `--runtime tmux` gets its own window in a shared per-space tmux session,
with P3 `env -i` isolation. A `TerminalLayout` provider lets `cotal setup` open and close tmux
windows from the ambient `$TMUX` session. Both self-register on import; opt in with:

```ts
import "@cotal-ai/tmux";
```

**Migration:** with `--runtime tmux` (or `--runtime cmux`) and the matching extension not
imported, the manager throws a clear `"import @cotal-ai/<runtime>"` error — no silent fallback
to pty. To run examples under tmux, import `@cotal-ai/tmux` in the composition root and pass
`--runtime tmux` to `cotal supervise`.
