# Cotal docs

These describe the **protocol** — the wire contract that *is* Cotal. Each runnable example
documents itself in its own `examples/*/README.md`; working build-plans and research live in
the private `.internal/` submodule, not here.

## Start here

1. **[OVERVIEW.md](OVERVIEW.md)** — what Cotal is and what it should be able to do.
2. **[architecture.md](architecture.md)** — how it's built: A2A/SLIM influences, the
   package tiers, the manager, and the NATS/JetStream mapping.
3. **[claude-code-integration.md](claude-code-integration.md)** — how a coding agent joins:
   the plugin, hooks, MCP `cotal_*` tools, and agent files.

## Reference

- [getting-started.md](getting-started.md) — install and run a local mesh.
- [protocol-view.md](protocol-view.md) — one model, many surfaces (the `MeshView` shared model).
- [transport.md](transport.md) — the transport capability contract and the NATS binding.
- [spaces.md](spaces.md) — what a space is, and space vs channel.
- [security.md](security.md) — trust boundary, adversaries, what v0 does and doesn't protect.
- [web.md](web.md) — the `cotal web` observability dashboard.
- [examples.md](examples.md) — index of runnable examples.

## Maintaining

- [setup-internals.md](setup-internals.md) — how the `cotal` setup flow works (maintainer notes).
- [release.md](release.md) — release & publish.
