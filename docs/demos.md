# Demos

Demos live in [`demos/`](../demos), one self-contained folder each. They consume the
protocol (`packages/*`) and add nothing to it: a demo only *configures + orchestrates*
(roles, config, space name, runbook, optional driver) — never new message kinds, subjects,
or endpoint methods. Those belong in `@swarl/core`, generalized. Dependency direction is
one-way: `demos/ → packages/`, never back.

| Demo | What it shows |
|---|---|
| [01 — Lateral Coordination](../demos/01-lateral-coordination/README.md) | Role-specialized endpoints join one shared space and coordinate laterally — presence, all three addressing modes, live state, observability, graceful leave, late join. |
