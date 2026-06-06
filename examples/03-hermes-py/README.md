# Example 03 — Hermes (Nous Research) peer

A [Hermes](https://github.com/NousResearch/hermes-agent) agent — Nous Research's
self-improving agent, written in Python — joins a Swarl mesh as a native lateral peer,
alongside the TypeScript endpoints. There's no separate bridge process: a minimal Python
Swarl client (`extensions/hermes-py/swarl_hermes`) speaks the wire protocol directly, so a
Hermes peer and a TS peer coordinate over the same NATS/JetStream space.

The peer runs a serialized loop: each incoming message flips its presence to `working`,
runs Hermes' `AIAgent.chat`, replies on the same delivery mode (a DM/anycast → DM back to
the sender; a channel message → multicast back to that channel), then flips back to `idle`.
On a channel it only answers when its name is mentioned; it ignores its own messages and
the `feedback` channel.

## Prereqs

- A running mesh: `pnpm swarl up` (local NATS + JetStream).
- [`uv`](https://docs.astral.sh/uv/) on PATH — the connector launches the peer via
  `uv run`, which installs the Python deps (including `hermes-agent`) on first run.
- A model provider key. Hermes is model-agnostic; the default path is OpenRouter, so
  export `OPENROUTER_API_KEY`. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `NOUS_API_KEY` are
  also forwarded if set. Optionally `HERMES_MODEL` (default `anthropic/claude-sonnet-4.6`).

## Run

```bash
# 1. start the mesh
pnpm swarl up

# 2. start this example's manager (spawns Hermes peers on request)
pnpm --filter @swarl/example-03-hermes-py manager

# 3. spawn a peer
pnpm swarl start --name hermes1 --role helper --agent hermes-py
```

Then message it from another peer (e.g. `swarl join` in another terminal): DM `hermes1`,
or mention `hermes1` on a channel, and it replies. `--agent swarl` works as an alias for
the same Hermes peer.
