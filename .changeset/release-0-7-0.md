---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/delivery": minor
"@cotal-ai/cmux": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-opencode": minor
---

feat: agent orientation, spawn-from-anywhere, live space graph, model-aware spawning

A coordinated minor across the workspace (lockstep `fixed` group). No wire break — `protocolVersion`
stays 0.2.

**New**

- **`cotal_orientation`** — a self/context card MCP tool: an agent's identity, the channels it can
  read and post to, its capabilities, available tools, and who's present. Claude Code, OpenCode, and
  Hermes connectors all point new agents at it on boot for the same first-turn orientation.
- **Spawn from any directory** — `cotal spawn` resolves a running mesh from a registry, so agents can
  be spawned outside the project directory. The registry self-prunes space-mismatched and stale
  `current` entries; its dir is locked to `0700` so space names aren't world-readable.
- **Model- and harness-aware spawning** — `cotal start --model` overrides the model, the harness CLI
  is preflighted before spawn, and the harness/model knobs are shared across both spawn doors (CLI
  `cotal spawn` and MCP `cotal_spawn`).
- **Live space graph** — a force-directed graph view of a space in the web UI, backed by
  broker-sourced authoritative channel membership (offline agents drop from the graph immediately).

**Fixes & hardening**

- **Manager persona spawn is fail-loud and ACL-correct.** A spawn (`start` op / `cotal_spawn` /
  roster boot) now treats its argument as a persona ref (a filename in `.cotal/agents`), takes the
  mesh identity from the file's `name:` (auto-numbered on collision), fails loud on a missing persona,
  and always provisions read/post ACLs from the loaded persona. Previously a miss silently minted
  default creds (read `general` only, default-deny publish, no capabilities), so a persona spawned by
  display name, a typo, or a renamed file became a live agent with silently-wrong ACLs.
- **Mesh-connect resolution unified** — `web`/`console`/`join` (and the transient commands) route
  through a shared `resolveMeshTarget` + preflight: the recorded server/mode is honored (open ≠ auth),
  the `--server`+`--space` raw escape works again for open remote meshes, the `channels` subcommand is
  validated, and a silent wrong-mesh fallback is refused rather than connecting to the wrong broker.
- **`cotal web` no longer holds the account signing seed.** The dashboard used to keep the space
  `SpaceAuth` (which can mint *any* identity/role) in scope for the whole session, re-minting on every
  channel delete — a compromise of the loopback process could mint anything for the account. It now
  pre-mints one scoped `manager` cred at startup for the lone write path (channel delete) and lets the
  seed fall out of scope, shrinking the blast radius from "mint anything" to "purge channels as one
  manager". Open / `--creds` modes are unaffected (no seed; they use the connection creds).
