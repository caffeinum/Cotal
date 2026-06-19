# @cotal-ai/connector-hermes

The Hermes (Nous Research) adapter: connects the Hermes agent to the mesh as a lateral peer.
Ships a Python sidecar (`pyproject.toml` / `uv.lock`) alongside the TypeScript connector. A
sibling of the Claude Code and OpenCode adapters, over
[`@cotal-ai/connector-core`](../connector-core).

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules.
