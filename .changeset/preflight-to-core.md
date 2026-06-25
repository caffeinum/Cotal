---
"@cotal-ai/core": minor
"@cotal-ai/manager": patch
---

Lift the mesh-target **preflight** (probe → classify → friendly failure message + stale-entry prune)
out of the CLI and into `@cotal-ai/core` (`preflight.ts`), so the manager control commands share one
preflight rule with the rest of the CLI instead of a rawer reachability check.

- `@cotal-ai/core` now exports `preflightTarget`, `classifyPreflightFailure`, `preflightMessage`,
  `reachableMessage`, `pruneStaleMeshes`, and the `PreflightFailure` type. `preflightTarget` probes a
  resolved target and returns the classified decision (incl. whether to prune) **without** mutating
  the registry — pruning stays the caller's explicit act, never a side effect of probing.
- `cotal ps` / `start` / `stop` / `attach`: a down or registry-mismatched mesh now fails with the
  same one-sentence message + stale-entry prune the rest of the CLI gives (e.g. `no mesh running at
  … — run cotal up`), instead of a raw `Authorization Violation` / `Can't reach NATS`. They also
  prune dead registry entries before resolving, like `connectOrExit` does.

The CLI's `connectOrExit` / `pruneStaleMeshes` are an internal refactor only — same messages, same
exports (now re-exported from core); no behaviour change for `up` / `spawn` / `send` / `channels` /
`console` / `web`.
