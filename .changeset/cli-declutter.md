---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
---

refactor(cli): declutter the command surface (27 → 20 commands)

Trims the `cotal` CLI to 20 commands with no capability lost:

- `dm` / `msg` / `ask` are now subcommands of one dispatcher — `cotal send <dm|msg|ask>`. Subcommands avoid the shell-comment hazard of a `#channel` sigil; completion offers the sub-verbs, then the declared channels/roles.
- `watch` (a literal alias of `console --plain`) is removed — use `cotal console`.
- `signer` is folded into `cotal mint --signer`.
- The `cmux` command is retired; its runner role moves to `cotal supervise --runtime <pty|tmux|cmux>`. Onboarding (`cmux go`) was a dev-clone-only duplicate of `cotal setup`/`go`, so it is dropped.
- `demo` is hidden from help and completion (still runnable) via a new `hidden?` flag on the `Command` contract.
