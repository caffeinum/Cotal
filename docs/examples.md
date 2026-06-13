# Examples

Examples live in [`examples/`](../examples), one self-contained folder each. They consume the
protocol (`packages/*`) through one or more implementations and add nothing to it: an example
only *configures + orchestrates* (roles, config, space name, runbook, optional driver) and
picks which extensions to register — never new message kinds, subjects, or endpoint methods.
Those belong in `@cotal-ai/core`, generalized. Dependency direction is one-way:
`examples → implementations → packages`, never back.

| Example | What it shows |
|---|---|
| [01 — Lateral Coordination](../examples/01-lateral-coordination/README.md) | Role-specialized endpoints join one shared space and coordinate laterally — presence, all three addressing modes, live state, observability, graceful leave, late join. |
| [02 — Orchestrated Handoff (cmux)](../examples/02-cmux-handoff/README.md) | Four real Claude Code agents in cmux tabs ship one change across three repos: one human prompt, then agent-to-agent fan-out and an automatic API→web handoff over the mesh. |
| [03 — OpenAI Agents (TS)](../examples/03-openai-agents/README.md) | An [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (TypeScript) agent joins the mesh as a native peer — see [agent frameworks](agent-frameworks.md). |
| [03 — Vercel AI SDK](../examples/03-vercel-ai/README.md) | A [Vercel AI SDK](https://ai-sdk.dev/) agent joins the mesh as a native peer via a `generateText` loop. |
| [05 — Frontier Tower faces](../examples/05-frontier-faces/README.md) | Animated pixel-art avatars for OpenCode-hosted persona agents — a terminal face that lip-syncs the live reply and steers its own expression, plus a tmux wall of them. |
