# Agent frameworks

Besides Claude Code (see [claude-code-integration](claude-code-integration.md)), agents
built with general-purpose SDKs can join a Swarl space as native lateral peers. Three
adapters ship today:

| Extension | Framework | Language |
|---|---|---|
| `@swarl/openai-agents` | [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | TypeScript |
| `@swarl/vercel-ai` | [Vercel AI SDK](https://ai-sdk.dev/) | TypeScript |
| `@swarl/openai-agents-py` | [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | Python |

They all join the same mesh and interoperate — an OpenAI-Agents peer, a Vercel peer, and a
Python peer in one space coordinate over the same subjects, presence, and delivery modes.

## The pattern: a native embedded peer

Each adapter embeds a Swarl endpoint in the framework's own process — not a separate
bridge. The shared piece is `MeshAgent` (in `@swarl/core`): it owns the NATS connection,
presence, and a buffered inbox, and emits `"incoming"` for each message. An adapter wires
two things around it:

1. **Mesh as tools.** The framework's tool mechanism (`tool()` for OpenAI Agents / Vercel,
   `@function_tool` for Python) exposes `swarl_send`, `swarl_dm`, `swarl_anycast`,
   `swarl_roster`, `swarl_status` — so the *model* can coordinate when it chooses to.
2. **Inbound drives the loop.** On `"incoming"`, the peer flips presence to `working`, runs
   the agent with the message text, and replies on the same delivery mode (DM/anycast → DM
   the sender; channel → multicast back), then flips to `idle`. Runs are serialized, and to
   avoid storms the peer answers DMs and anycasts but only replies on a channel when its name
   is mentioned (and never to its own messages or the `feedback` channel).

This makes the agent a real peer that wakes on traffic, like Claude Code — not a pull-only
tool caller.

A `Connector` extension (`buildLaunch`) lets the manager spawn each type. The TypeScript
peers launch via `tsx`; the Python peer launches via `uv run` and speaks the wire protocol
through a minimal client (`extensions/openai-agents-py/swarl_py`) that ports `core`'s
subjects, message envelope, and presence KV — so a Python peer and a TS peer share one mesh.

## Running

Each adapter has an example composition root under `examples/03-*` (a manager that registers
the connector). See those READMEs to run one; in short:

```bash
pnpm swarl up
export OPENAI_API_KEY=sk-...
pnpm --filter @swarl/example-03-openai-agents manager
pnpm swarl start --name oa1 --role helper --agent openai-agents
```

Swap `openai-agents` for `vercel-ai` or `openai-agents-py` (and the matching example) to run
the others. Register more than one connector in a single manager to put different frameworks
in the same space.
