# Setup internals (maintainer notes)

How `cotal setup` works, and the cross-repo couplings it depends on. If you change one
of the things in the **Invariants** table, update the listed siblings in the same change
or setup silently breaks for npx users.

## The flow

`cotal setup` ([`implementations/cli/src/commands/setup.ts`](../implementations/cli/src/commands/setup.ts))
is two-tier, gated on a machine marker:

- **First run** (no `~/.cotal/onboarded.json`, or `--full`, or `--yes`) → `runFirstRun`:
  splash → intro → core steps (Node, NATS, start the mesh) → start the **web dashboard** + the
  **manager** in the background → **connector picker** → write the two default experts (david/sven)
  → marker → demo finale. The finale is a cmux-only live demo: it opens a **cmux-runtime manager**
  (`cotal cmux --spawn david,sven`) that owns david/sven (so they're despawnable) plus a focused
  console + `me` driver. With no cmux / declined, it starts the background **pty manager** instead
  and shows the `cotal · ready` card. Under `--yes` neither is started (so `cotal cmux go` and CI
  start / need their own).
- **Later runs** → `runEnsure`: ensures the mesh + dashboard are up; **inside cmux** (gated on
  `CMUX_SURFACE_ID`) it reopens the working session via `ensureCmuxSession` (idempotent — reuses the
  live manager + david/sven, opens only missing tabs), otherwise it starts the background pty
  manager. Then a compact status card. This is the "re-run `cotal setup` reopens your session" path.

The **web dashboard** (`ensureWeb` in [`commands/web.ts`](../implementations/cli/src/commands/web.ts))
auto-starts detached on the default port, addressed as `http://cotal.localhost:7799` (the server
binds loopback; `*.localhost` resolves to it in Chrome/Firefox/Edge — Safari may need plain
`127.0.0.1`). It re-execs the CLI (`process.execArgv` carries the tsx loader in dev, empty in prod).

Steps run in-process via `runSteps` ([`lib/steps.ts`](../implementations/cli/src/lib/steps.ts)).
A step can be `optional` (asked Y/n), carry a `confirm` consent prompt, or be `live`
(draws its own pane via [`lib/live-window.ts`](../implementations/cli/src/lib/live-window.ts)).
On failure, an interactive run offers a Claude handoff ([`lib/assist.ts`](../implementations/cli/src/lib/assist.ts)).

The **connector picker** (`pickConnectors`) multiselects Claude / Codex / OpenCode (detected
pre-checked). Only **Claude** runs an install (its wake channel binds to an *installed* plugin);
**Codex/OpenCode auto-wire at spawn** (they inject MCP/plugin via `buildLaunch`, never writing
the user's config) so the picker just marks them ready. Two experts (david, the engineer; sven,
the guide) plus the operator's own driving session (`me`) are written by default; `me` also
backs `cotal cmux go`'s `spawn me`.

**`--yes`** forces non-interactive accept-all even on a TTY: optional + `confirm` steps
run (so demo agents are written), the demo finale is skipped, and a failure aborts with
the log path and a non-zero exit. This is the agent/CI contract; keep it working.

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
| cmux session | `CMUX_SURFACE_ID` gate + `workspaceExists` from [`extensions/cmux/src/driver.ts`](../extensions/cmux/src/driver.ts) | `ensureCmuxSession` opens a `cotal cmux --spawn david,sven` manager tab (owns david/sven so they're despawnable) + a focused `cotal-main` workspace, each only if not already open (idempotent re-entry) |

## Background processes

Three detached processes back a folder, all stopped by `cotal down`:

- **Mesh** — `startMeshDetached` ([`commands/up.ts`](../implementations/cli/src/commands/up.ts))
  is the one place that boots a background nats-server (also used by `up --detach`). Writes
  `.cotal/nats.pid` and tails `.cotal/nats.log` for the live pane.
- **Web dashboard** — `startWebDetached` / `ensureWeb`
  ([`commands/web.ts`](../implementations/cli/src/commands/web.ts)) re-execs `cotal web` detached.
  Writes `.cotal/web.pid` and `.cotal/web.log`. `webUp()` probes the port for the status card.
- **Manager** — `startManagerDetached` / `ensureManager`
  ([`lib/manager-proc.ts`](../implementations/cli/src/lib/manager-proc.ts)) re-execs `cotal supervise`
  detached (pty runtime); it answers the control plane (`cotal_spawn`/`despawn`/`purge`/`persona`).
  Writes `.cotal/manager.pid` and `.cotal/manager.log`; `managerUp()` checks pid liveness for the
  card. `cotal cmux go` SIGTERMs this pid first so its cmux-runtime manager is the only one.
