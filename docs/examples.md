# Examples

Examples live in [`examples/`](../examples), one self-contained folder each. They consume the
protocol (`packages/*`) through one or more implementations and add nothing to it: an example
only *configures + orchestrates* (roles, config, space name, runbook, optional driver) and
picks which extensions to register — never new message kinds, subjects, or endpoint methods.
Those belong in `@swarl/core`, generalized. Dependency direction is one-way:
`examples → implementations → packages`, never back.

| Example | What it shows |
|---|---|
| [01 — Lateral Coordination](../examples/01-lateral-coordination/README.md) | Role-specialized endpoints join one shared space and coordinate laterally — presence, all three addressing modes, live state, observability, graceful leave, late join. |
| [02 — Orchestrated Handoff (cmux)](../examples/02-cmux-handoff/README.md) | Four real Claude Code agents in cmux panes ship one change across three repos: one human prompt, then agent-to-agent fan-out and an automatic API→web handoff over the mesh. |
| [03 — OpenAI Agents (TS)](../examples/03-openai-agents/README.md) | An [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (TypeScript) agent joins the mesh as a native peer — see [agent frameworks](agent-frameworks.md). |
| [03 — Vercel AI SDK](../examples/03-vercel-ai/README.md) | A [Vercel AI SDK](https://ai-sdk.dev/) agent joins the mesh as a native peer via a `generateText` loop. |
| [03 — OpenAI Agents (Python)](../examples/03-openai-agents-py/README.md) | An [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) (Python) agent joins over a minimal Python wire client — interoperating with the TS peers. |
| [03 — Hermes (Python)](../examples/03-hermes-py/README.md) | A [Hermes](https://github.com/NousResearch/hermes-agent) (Nous Research) agent embeds its `AIAgent` and joins over the Python wire client — interoperating with the TS peers. |
