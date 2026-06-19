# @cotal-ai/core

The Cotal protocol: the endpoint, subjects, and message types, plus the NATS client layer and
the extension contracts (`Connector`, `Command`, `Runtime`) and the `Registry` they
self-register into.

**Tier:** `packages/` (the standard). Everything depends on core; core depends on nothing else
in the repo.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules, [SPEC.md](../../SPEC.md) for the
normative wire contract, and [docs/](../../docs/) for the protocol.
