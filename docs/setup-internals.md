# Setup internals (maintainer notes)

How `cotal setup` works, and the cross-repo couplings it depends on. If you change one
of the things in the **Invariants** table, update the listed siblings in the same change
or setup silently breaks for npx users.

## The flow

`cotal setup` ([`implementations/cli/src/commands/setup.ts`](../implementations/cli/src/commands/setup.ts))
is two-tier, gated on a machine marker:

- **First run** (no `~/.cotal/onboarded.json`, or `--full`, or `--yes`) → `runFirstRun`:
  splash → intro → core steps (Node, NATS, start the web) → **connector picker** → write the
  two default experts (david/sven) → marker → demo finale.
- **Later runs** → `runEnsure`: a compact status card; starts a web in the cwd if none.

Steps run in-process via `runSteps` ([`lib/steps.ts`](../implementations/cli/src/lib/steps.ts)).
A step can be `optional` (asked Y/n), carry a `confirm` consent prompt, or be `live`
(draws its own pane via [`lib/live-window.ts`](../implementations/cli/src/lib/live-window.ts)).
On failure, an interactive run offers a Claude handoff ([`lib/assist.ts`](../implementations/cli/src/lib/assist.ts)).

The **connector picker** (`pickConnectors`) multiselects Claude / Codex / OpenCode (detected
pre-checked). Only **Claude** runs an install (its wake channel binds to an *installed* plugin);
**Codex/OpenCode auto-wire at spawn** (they inject MCP/plugin via `buildLaunch`, never writing
the user's config) so the picker just marks them ready. The two experts (david — the engineer,
sven — the guide) are written by default.

**`--yes`** forces non-interactive accept-all even on a TTY: optional + `confirm` steps
run (so demo agents are written), the demo finale is skipped, and a failure aborts with
the log path and a non-zero exit. This is the agent/CI contract — keep it working.

## Invariants

| Thing | Must stay in sync across | Why |
|---|---|---|
| Marketplace name **`cotal-mesh`** | `setup.ts` (materialized `marketplace.json`), `CHANNEL_REF` in [`extensions/connector-claude-code/src/extension.ts`](../extensions/connector-claude-code/src/extension.ts), repo [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | The wake channel ref `plugin:cotal@cotal-mesh` binds by this name |
| Plugin assets | `setup.ts` copy list (`dist/mcp.cjs`, `dist/hook.cjs`, `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`) and the connector `package.json` `files` field | Setup materializes the plugin from `Connector.pluginRoot`; missing/renamed assets break the install |
| `Connector.pluginRoot` | [`packages/core/src/connector.ts`](../packages/core/src/connector.ts) (contract) + set in the claude connector's `extension.ts` | How setup finds the plugin dir without importing the extension |
| `BUNDLED_PKG_PREFIX` | [`lib/nats-bin.ts`](../implementations/cli/src/lib/nats-bin.ts) ↔ the `@eplightning/nats-server-*` `optionalDependencies` in [`implementations/cli/package.json`](../implementations/cli/package.json) | The bundled NATS binary is resolved by `${prefix}-${platform}-${arch}`. (Future: swap the prefix to our own `@cotal-ai/nats-server-*`.) |
| Onboard marker + `ONBOARD_VERSION` | `~/.cotal/onboarded.json` in [`lib/onboard.ts`](../implementations/cli/src/lib/onboard.ts); version const in `setup.ts` | Flips first-run vs ensure |
| Demo-agent format | `DEMO_AGENTS` in `setup.ts` matches the frontmatter shape read by [`packages/core/src/agent-file.ts`](../packages/core/src/agent-file.ts) (same as `examples/01-lateral-coordination/agents/`) | `cotal spawn <name>` loads these |
| `DEFAULT_SERVER` | [`packages/core/src/endpoint.ts`](../packages/core/src/endpoint.ts) | The address setup starts/checks |
| cmux demo | layout JSON + `cmux.available()` from [`extensions/cmux/src/driver.ts`](../extensions/cmux/src/driver.ts) | The finale opens a workspace running `cotal spawn` per pane |

## Shared mesh start

`startMeshDetached` ([`commands/up.ts`](../implementations/cli/src/commands/up.ts)) is the
one place that boots a background server (also used by `up --detach`). It writes
`.cotal/nats.pid` (stopped by `cotal down`) and tails `.cotal/nats.log` for the live pane.
