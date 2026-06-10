---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/cli": patch
---

Add the `cotal_feedback` beta egress: a `COTAL_FEEDBACK_KEY` config plus `feedbackLine()` guidance folded into the Claude/Codex connector instructions, and a `cotal feedback` authenticated intake server (tester keys, JSONL source of truth, republish to an internal `#feedback` channel). Note: the agent-side `cotal_feedback` tool registration is still pending.
