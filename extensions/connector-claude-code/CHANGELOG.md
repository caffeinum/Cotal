# @cotal-ai/connector-claude-code

## 0.2.0

### Minor Changes

- 0954ea6: Transcript mirror: a managed Claude Code session now publishes its own condensed
  transcript (assistant text, tool one-liners, truncated results) to a per-agent
  `tr-<name>` channel, driven by the lifecycle hooks' `transcript_path`. Gated by
  `COTAL_TRANSCRIPT`, which `buildLaunch` sets for managed sessions; personal
  sessions never mirror.

### Patch Changes

- 73b030f: Add the `cotal_feedback` sender: a connector tool (always exposed) and a `cotal feedback "<summary>"` CLI mode. With a `COTAL_FEEDBACK_KEY` feedback routes to the keyed broker intake as before; without one it goes to the public intake at `https://cotal.ai/v1/feedback`, which requires a contact email (`COTAL_FEEDBACK_EMAIL` → git config → ask). `COTAL_FEEDBACK_URL` overrides either URL for self-hosted intakes.
- Updated dependencies [b3a790e]
- Updated dependencies [73b030f]
- Updated dependencies [739649a]
  - @cotal-ai/core@0.1.3
  - @cotal-ai/connector-core@0.2.0

## 0.1.3

### Patch Changes

- 246c9b9: Add the `cotal_feedback` beta egress: a `COTAL_FEEDBACK_KEY` config plus `feedbackLine()` guidance folded into the Claude/Codex connector instructions, and a `cotal feedback` authenticated intake server (tester keys, JSONL source of truth, republish to an internal `#feedback` channel). Note: the agent-side `cotal_feedback` tool registration is still pending.
- Updated dependencies [246c9b9]
- Updated dependencies [246c9b9]
  - @cotal-ai/connector-core@0.1.3

## 0.1.2

### Patch Changes

- 5f9e171: Publish all packages: add repository field for OIDC provenance, plus in-flight changes (cmux runtime exec-via-env fix, manager runtime selector, .gitignore product/, etc.).
- Updated dependencies [5f9e171]
  - @cotal-ai/core@0.1.2
  - @cotal-ai/connector-core@0.1.2

## 0.1.1

### Patch Changes

- 18c271f: Publish all packages: configure GitHub Actions changesets workflow with npm OIDC trusted publishing.
- Updated dependencies [18c271f]
  - @cotal-ai/core@0.1.1
  - @cotal-ai/connector-core@0.1.1
