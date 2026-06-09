# Codex connector

> Hooks: [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks) ·
> app-server: [developers.openai.com/codex/app-server](https://developers.openai.com/codex/app-server)
> (built + verified against codex-cli 0.136.0).

The connector turns a real `codex` session into a Cotal mesh peer — two surfaces over the shared
runtime in [`@cotal-ai/connector-core`](../extensions/connector-core):

- **`codex` (attach)** — the normal Codex TUI, with the `cotal_*` MCP server **and lifecycle hooks**
  injected via `codex -c` (nothing written to `~/.codex`). Presence + inbox injection, like Claude.
- **`codex-app-server` (host)** — a headless peer that drives `codex app-server` over JSON-RPC for
  true wake / steer / interrupt of a *live* session.

Both are identity-gated (`hasIdentity()`): a plain `codex` with no `COTAL_*` env stays off the mesh.

## codex (attach): MCP + hooks

[`src/extension.ts`](../extensions/connector-codex/src/extension.ts) builds the launch:

```
codex -c mcp_servers.cotal.command=<tsx> -c mcp_servers.cotal.args=[<mcp.ts>] \
      -c mcp_servers.cotal.env.COTAL_*=…  -c approval_policy="never"  -c sandbox_mode="workspace-write" \
      -c 'hooks.SessionStart=[{ hooks = [{ type = "command", command = "<tsx> <hook.ts>" }] }]'  …  \
      --dangerously-bypass-hook-trust
```

- **MCP, in-memory.** Identity rides the server's `env` table (Codex gives MCP servers a clean env,
  so process env isn't forwarded there). `default_tools_approval_mode="auto"` + `approval_policy=
  "never"` + `sandbox_mode="workspace-write"` make a spawned agent autonomous — no approval deadlock.
- **Hooks → presence + inbox.** Codex's hooks framework mirrors Claude Code's (same JSON on stdin →
  `hookSpecificOutput.additionalContext` on stdout), so connector-core's relay (`hook.ts` → control
  socket → `control.ts`) ports verbatim. Map: `SessionStart`→idle (+inject inbox), `UserPromptSubmit`
  →working (+inject), `PermissionRequest`→waiting, `Stop`→idle. The hook is a single `command` string
  (Codex's schema has no `args` array, unlike Claude's plugin hooks.json) run via tsx; it inherits
  `COTAL_SPACE`/`COTAL_NAME` from the codex *process* env to find the control socket.
  `--dangerously-bypass-hook-trust` skips the one-time trust prompt for a supervised spawn.
- **No mid-idle wake.** Codex has no `claude/channel` analog, so an idle TUI isn't woken between
  turns — held messages drain at the next `UserPromptSubmit`. For true wake/steer, use the host below.

## codex-app-server (host): drive a live session

[`host.ts`](../extensions/connector-codex/src/host.ts) embeds a `MeshAgent` in the same process as an
`AppServerDriver` ([`app-server.ts`](../extensions/connector-codex/src/app-server.ts)), which owns a
`codex app-server` child and speaks the app-server **v2** JSON-RPC (JSONL over stdio — the same
protocol the TUI / VS Code extension use; the wire omits the `jsonrpc` field). A mesh message becomes
a real user turn:

- idle → `turn/start` (wake); a turn already running → `turn/steer` (true mid-turn inject, no abort);
  shutdown → `turn/interrupt`.
- Presence is read off the event stream: `turn/started`→working, `turn/completed`→idle, an approval
  request→waiting (auto-accepted to stay autonomous). Each turn's final `agentMessage` is routed back
  to whoever prompted it (channel→`send`, dm/anycast→`dm`).

No native TUI — the human view comes via the manager's attach/WS. Reply routing is host-mediated and
serialised (one turn at a time); proactive sends *by the agent* (its own `cotal_*` tools) are a
follow-up — the host owns all mesh I/O so there is one mesh identity, not two.

The host is **directed-only**: it acts on DMs, anycasts, and @-mentions; ambient channel chatter is
dropped, not surfaced (unlike the attach surface, whose hook injects the whole inbox) — keeping a
headless peer focused and its inbox bounded. It drives off the mesh inbox with **ack-on-completion**:
a turn's surfaced messages are `drainInbox()`-acked only when the turn ends un-interrupted (a `failed`
turn acks to avoid a retry-loop; only `interrupted`/crash redelivers), and a message is steered into
the live turn only when it shares that turn's scope (`channel:<ch>` vs `dm:<id>`), so a DM never
rides a channel broadcast.

## Verified

Built + typechecked against codex-cli 0.136.0 (the app-server protocol bindings are generated from
the same binary via `codex app-server generate-ts`). The driver's handshake — spawn → `initialize` →
`thread/start` returning a real thread id — is exercised against the real binary. A full model turn
and the live hook→socket path need an authenticated `codex` (not run in CI).
