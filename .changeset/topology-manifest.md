---
"@cotal-ai/cli": minor
---

Add a mesh manifest: describe and launch a whole topology from one channel-centric `cotal.yaml` (`kind: Mesh`).

- `cotal up -f <cotal.yaml>` brings up a **fresh** mesh — broker + seeded channels + booted agents — and owns the whole space (`cotal down` tears it down). A broker already reachable at the manifest's address is refused with a redirect to `spawn -f` (never re-seeded as fresh). `--dry-run` previews the plan and mutates nothing.
- `cotal topology view -f <cotal.yaml>` validates the manifest and renders its access graph (per-channel and per-agent subscribe/read/post, persona-inherited scopes, warnings) — read-only, no broker needed.

The file is organized by channel (each lists `subscribe`/`allowSubscribe`/`allowPublish` — Cotal's native verbs, holding agent names); a top `agents:` table resolves each name to a persona (bare path / file + overrides / fully inline) and a connector (`agent:`, per-agent or a top-level default — no silent default). Persona files supply model/role/instructions (manifest overrides win); under `personaPermissions: include` a persona's own channel grants are inherited for channels the manifest doesn't declare. Resolved agents boot via a transient, non-authoritative launch artifact under `.cotal/run/` — no generated personas in `.cotal/agents/`.
