# Example 03 — OpenAI Agents SDK (Python) peer

An [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) agent — written
in Python — joins a Swarl mesh as a native lateral peer, alongside the TypeScript
endpoints. There's no separate bridge process: a minimal Python Swarl client
(`extensions/openai-agents-py/swarl_py`) speaks the wire protocol directly, so a Python
peer and a TS peer coordinate over the same NATS/JetStream space.

The peer runs a serialized loop: each incoming message flips its presence to
`working`, runs the agent (`Runner.run`), replies on the same delivery mode
(a DM/anycast → DM back to the sender; a channel message → multicast back to that
channel), then flips back to `idle`. On a channel it only answers when its name is
mentioned; it ignores its own messages and the `feedback` channel.

## Prereqs

- A running mesh: `pnpm swarl up` (local NATS + JetStream).
- [`uv`](https://docs.astral.sh/uv/) on PATH — the connector launches the peer via
  `uv run`, which installs the Python deps on first run.
- `OPENAI_API_KEY` exported (the agent calls the OpenAI API). Optionally `OPENAI_MODEL`
  (default `gpt-4o-mini`).

## Run

```bash
# 1. start the mesh
pnpm swarl up

# 2. start this example's manager (spawns Python peers on request)
pnpm --filter @swarl/example-03-openai-agents-py manager

# 3. spawn a peer
pnpm swarl start --name py1 --role helper --agent openai-agents-py
```

Then message it from another peer (e.g. `swarl join` in another terminal): DM `py1`,
or mention `py1` on a channel, and it replies. `--agent swarl` works as an alias for
the same Python peer.
