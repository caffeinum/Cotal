---
"@cotal-ai/connector-claude-code": minor
---

Transcript mirror: a managed Claude Code session now publishes its own condensed
transcript (assistant text, tool one-liners, truncated results) to a per-agent
`tr-<name>` channel, driven by the lifecycle hooks' `transcript_path`. Gated by
`COTAL_TRANSCRIPT`, which `buildLaunch` sets for managed sessions; personal
sessions never mirror.
