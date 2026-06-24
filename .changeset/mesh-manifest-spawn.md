---
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Mesh manifest, part 2: deploy onto a running mesh + ownership-scoped teardown.

- `cotal spawn -f <cotal.yaml>` deploys a manifest **additively** onto a mesh that's already running (the counterpart to `up -f`, which only ever brings up a fresh one). It classifies each declared channel (brand-new → seeded + owned; already present → `exists-unmanaged`, its card left untouched) and agent (will-create / already-owned / stale), boots agents through the running manager, and records exactly what it created in a creation-only ledger (`.cotal/manifests/<runId>.json`). `--dry-run` previews the plan; a re-declared agent whose policy changed is **stale** and exits non-zero unless `--allow-stale <names>`. Unmanaged actors with access to a declared channel are surfaced as a SECURITY warning (an explicit lower bound — presence + the membership feed, not live-only subscriptions).
- `cotal down -f <cotal.yaml>` (or `--run <id>`) tears down **only** what a `spawn -f` run created — its agents and the channels it added — never foreign actors on the shared mesh. The ledger is treated as untrusted input and validated whole before any deletion; an owned agent is stopped only when its recorded name **and** id match the live one; cred paths are derived from the auth root and deleted without following symlinks; an owned channel is removed only when no other members remain. An edited manifest no longer matches its ledger and fails with a `--run` hint rather than guessing. Local-only: same checkout/host that created the run.

Both verbs share the manifest pipeline and the resolved launch-spec handoff; `spawn -f` boots via a new **operator-only** manager `launch` control op (it reads the run spec by id, never an arbitrary path).
