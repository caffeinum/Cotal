# OpenCode connector

> Verified against `opencode` / `@opencode-ai/{plugin,sdk}` **1.16.2**.

The connector turns a real `opencode` server into a Cotal mesh peer. OpenCode is
client/server (`opencode serve` is a headless HTTP server with an SSE event bus and a TS
SDK), so unlike Claude Code (channel nudge) or Codex (pull-only), the whole integration is
an **in-process plugin** that runs inside the server: it joins NATS, registers the mesh
tools natively, maps the event bus to presence, and **drives the session** — an incoming
peer message wakes a turn by injecting a prompt over the in-process SDK client.

> The mesh runtime — agent, `cotal_*` tool logic, inbox — lives in
> [`@cotal-ai/connector-core`](../extensions/connector-core); this package is the
> OpenCode-specific adapter over it (siblings: [`@cotal-ai/connector-claude-code`](../extensions/connector-claude-code),
> [`@cotal-ai/connector-codex`](../extensions/connector-codex)). OpenCode is TypeScript, so
> connector-core embeds directly — no language bridge.

## How a session joins

[`extensions/connector-opencode/src/extension.ts`](../extensions/connector-opencode/src/extension.ts)
builds the launch the manager runs:

```
node dist/serve.js                       # the shim → opencode serve --hostname 127.0.0.1 --port <free>
# env: COTAL_SPACE, COTAL_NAME, COTAL_ROLE, COTAL_SERVERS, OPENCODE_CONFIG_CONTENT
```

- **Inline config, nothing written.** Identity rides `COTAL_*` env (the plugin runs in the
  opencode process and inherits it). The plugin + `permission:"allow"` are passed via
  `OPENCODE_CONFIG_CONTENT` — inline JSON, the highest merge layer — so the operator's
  `~/.config/opencode` is never touched (the Codex `-c` trick, in JSON).
- **`permission:"allow"` is required.** `opencode serve` does **not** auto-approve: an
  `"ask"` permission with no client attached hangs the tool call forever. A supervised,
  human-less peer must allow-all or it deadlocks on the first tool.
- **Launcher shim ([`serve.ts`](../extensions/connector-opencode/src/serve.ts)).** OpenCode
  loads plugins **lazily** — on the first HTTP request, not at boot — so a client-less server
  would never load the plugin and never join. The shim starts `serve` on a free port (the
  default `4096` collides when peers co-locate; `--port 0` falls back to it) and pokes it once
  to force the plugin and the mesh join to initialize, then just forwards stdio + signals.
- **One endpoint per process.** OpenCode invokes the plugin once per app/worktree scope, so
  the plugin function can run more than once. A process-global guard creates the `MeshAgent`
  once and returns the *same* hooks (the same tools, one agent) on every call.
- **Identity-gated.** No `COTAL_NAME`/`COTAL_LINK`/`COTAL_AGENT_FILE` ⇒ the plugin stays
  inert and never joins (`hasIdentity()` in [`config.ts`](../extensions/connector-core/src/config.ts)),
  so an operator's own `opencode` doesn't appear as a stray peer.

## Tools (native, not MCP)

OpenCode plugins register model-callable tools directly (the `tool()` helper, zod via
`tool.schema`), so the cotal_* surface is wired straight to the in-process `MeshAgent` — no
separate stdio MCP server, one mesh endpoint. Same tools as the MCP connectors:
`cotal_roster` / `cotal_inbox` / `cotal_send` / `cotal_dm` / `cotal_anycast` / `cotal_status`
/ `cotal_spawn` ([`tools.ts`](../extensions/connector-opencode/src/tools.ts)).

## Presence mapping

Presence comes off the OpenCode **event bus** (the plugin `event` hook), not lifecycle
command-hooks. Coarse states (`idle | waiting | working | offline`):

| Event | → state |
|---|---|
| plugin load / `session.idle` / `session.status{idle}` | `idle` |
| `session.status{busy}` / `tool.execute.before` | `working` (activity = running tool) |
| `session.status{retry}` | `working` (activity = retry reason) |
| `permission.updated` | `waiting` (activity = the prompt title) |
| `session.error` | `idle` (turn died) |
| `session.deleted` / `dispose` | `offline` |

## Message delivery (stream-backed) & drive

Peer messages land in the connector's inbox from durable JetStream consumers (nothing is
lost while busy/offline). The plugin moves them to the model by **driving the session**:

- **Wake.** On an incoming message the plugin injects a prompt over the SDK
  (`client.session.promptAsync`) so the session runs a turn and replies with the cotal_*
  tools. OpenCode rejects a prompt mid-turn (`BusyError`), so we only drive when idle.
- **Two tiers.** A *directed* message (DM / anycast / @mention) aborts a running turn — the
  resulting `session.idle` drains it **now**; *ambient* channel chatter queues and drains on
  the next `session.idle`. There is no seamless mid-turn steer (an upstream limitation), so
  urgent = abort + re-prompt.
- The session is created lazily on the first wake; persona (agent-file body) rides the first
  prompt's `system`, and the agent-file `model` (`provider/model`) the prompt's `model`.

## Build

The connector is built **and bundled** (`pnpm --filter @cotal-ai/connector-opencode build`):
`tsc` emits `dist/` (the connector + the `serve.js` shim, Node-builtins only), and esbuild
bundles the plugin to a single self-contained `dist/plugin.bundle.js` that opencode loads by
absolute path. `@opencode-ai/*` stay external (the host provides them).

## Notes / limits

- Running a turn needs an OpenCode provider configured (`opencode auth`); the mesh join,
  presence, and tools work without it, but a wake can't produce a reply.
- `noReply:true` (inject context without a turn) is regression-prone upstream, so ambient
  messages are queued and drained on idle rather than injected silently.
