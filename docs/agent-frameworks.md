# Agent frameworks

Besides Claude Code (see [claude-code-integration](claude-code-integration.md)), agents
built with general-purpose SDKs can join a Cotal space as native lateral peers. Two
adapters ship today:

| Extension | Framework | Language |
|---|---|---|
| `@cotal/openai-agents` | [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | TypeScript |
| `@cotal/vercel-ai` | [Vercel AI SDK](https://ai-sdk.dev/) | TypeScript |

Both join the same mesh and interoperate — an OpenAI-Agents peer and a Vercel peer in one
space coordinate over the same subjects, presence, and delivery modes.

## The pattern: a native embedded peer

Each adapter embeds a Cotal endpoint in the framework's own process — not a separate
bridge. The shared piece is `MeshAgent` (in `@cotal/connector-core`, the same runtime
behind the Claude Code and Codex connectors): it owns the NATS connection, presence, and a
buffered inbox, and emits `"incoming"` for each message. An adapter wires two things around
it:

1. **Inbound drives the loop.** On `"incoming"`, the peer flips presence to `working`, runs
   the agent with the message text, and delivers the agent's reply on the same delivery mode
   (DM/anycast → DM the sender by id; channel → multicast back to that channel), then flips
   to `idle`. The loop owns delivery, so a reply is always routed correctly and sent exactly
   once. Runs are serialized, and to avoid storms the peer answers DMs and anycasts but only
   replies on a channel when its name is mentioned (and never to its own messages).
2. **Mesh awareness as tools.** The model also gets read/presence tools via the framework's
   tool mechanism (`tool()` for both SDKs): `cotal_roster` (who's present) and `cotal_status`
   (set its own status). Sending is left to the loop, so the model can't mis-route or
   duplicate a reply.

This makes the agent a real peer that wakes on traffic, like Claude Code — not a pull-only
tool caller.

A `Connector` extension (`buildLaunch`) lets the manager spawn each type: it launches the
peer via `tsx` and forwards the launcher's identity (`COTAL_ID`), minted creds
(`COTAL_CREDS`), and any agent file (`COTAL_AGENT_FILE`), so under auth the peer
authenticates as the id the manager provisioned. The connectors self-register on import
(`openai-agents`, `vercel-ai`); a composition root just imports the one it wants.

## Running

Each adapter has an example composition root under `examples/03-*` (a manager that imports
the connector). See those READMEs to run one; in short:

```bash
pnpm cotal up
export OPENAI_API_KEY=sk-...
pnpm --filter @cotal/example-03-openai-agents manager
pnpm cotal start --name oa1 --role helper --agent openai-agents
```

Swap `openai-agents` for `vercel-ai` (and the matching example) to run the other. Import
both connectors in a single manager to put different frameworks in the same space.
