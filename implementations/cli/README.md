# @cotal-ai/cli

The mesh CLI: `up`, `join`, `watch`, `console`, `web`, `spawn`, `mint`, `channels`, `history`.
These are thin NATS clients over core, plus `spawn` (a foreground agent launch reusing the
connector's launch recipe).

**Tier:** `implementations/` (a self-contained surface over core). Implementations never import
each other; they meet at runtime over NATS.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules and
[docs/getting-started.md](../../docs/getting-started.md) to run a local mesh.
