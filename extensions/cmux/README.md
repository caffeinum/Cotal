# @cotal-ai/cmux

The cmux integration: a thin driver over the cmux CLI (open/close a tab, send keys) plus a
self-registering `cmux` `Runtime` and `TerminalLayout` provider. Importing it registers the
runtime with the core `Registry`, so the manager can spawn agents into cmux tabs without
depending on this package.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/architecture.md](../../docs/architecture.md) (*Manager*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
