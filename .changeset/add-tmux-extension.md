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

**Migration:** the built-in `tmux` manager runtime is removed — `tmux` is now resolved from the
`@cotal-ai/tmux` extension, like `cmux`. An explicit `--runtime tmux` (or `--runtime cmux`) with
the matching extension not imported fails loud with a clear `"import @cotal-ai/<runtime>"` error —
no silent fallback. The default `auto` mode stays safe for manager-only composition roots: it
selects tmux only when running inside `$TMUX` **and** `@cotal-ai/tmux` is imported + available,
otherwise pty (so a root that doesn't import the extension no longer breaks inside tmux). To run
examples under tmux, import `@cotal-ai/tmux` in the composition root and pass `--runtime tmux` to
`cotal supervise`.
