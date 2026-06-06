# Claude Code connector

> Hook source: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) (Claude Code 2.1.16x — 31 events).

The connector turns a real `claude` session into a Swarl mesh peer: a bundled plugin inside the
session joins NATS, maps lifecycle hooks to presence, and exposes the mesh tools. The manager
spawns it in a PTY; nothing wraps Claude — it's an ordinary session that happens to be on the mesh.

> The mesh runtime — agent, `swarl_*` tools, hook relay — lives in
> [`@swarl/connector-core`](../extensions/connector-core); this package is the Claude-specific adapter
> over it (its Codex sibling is [`@swarl/connector-codex`](../extensions/connector-codex)).

## How a session joins

[`extensions/connector-claude-code/src/extension.ts`](../extensions/connector-claude-code/src/extension.ts) builds the
launch the manager runs:

```
claude --dangerously-load-development-channels plugin:swarl@swarl-mesh
# env: SWARL_SPACE, SWARL_NAME, SWARL_ROLE, SWARL_SERVERS, SWARL_CHANNEL=1
```

- **Installed, not `--plugin-dir`.** The plugin is installed once
  (`claude plugin install swarl@swarl-mesh --scope local`) — the wake channel only binds to an
  *installed* plugin, so `--plugin-dir` (which loads but doesn't "install") isn't enough. Local
  scope keeps it to this repo (a gitignored `.claude/settings.local.json`), never user-global.
- **Bundled.** The MCP server and hooks are esbuild-bundled to `dist/*.cjs` and run with plain
  `node` (`pnpm --filter @swarl/connector-claude-code bundle`); the [`.mcp.json`](../extensions/connector-claude-code/.mcp.json)
  and [`hooks.json`](../extensions/connector-claude-code/hooks/hooks.json) point at the bundles. Bundling is
  required because pnpm's symlinked `node_modules` don't survive Claude's copy-install.
- **Identity-gated.** Connector code requires `SWARL_NAME` (`hasIdentity()` in
  [`config.ts`](../extensions/connector-core/src/config.ts)); a plain `claude` with no `SWARL_*` env
  stays inert and never joins — so an operator's own sessions in the repo don't appear as stray peers.
- **Hands-free spawn.** The dev-channels flag prints a one-time "Enter to confirm" prompt; the PTY
  runtime auto-clears it via `LaunchSpec.confirm`, so a supervised launch needs no keypress.

## Presence mapping

The connector wires a small subset of these to Swarl presence states
(`idle | waiting | working | offline`). Presence is coarse — only hooks that cross a
state boundary move it; "what it's doing" rides on channel updates, not presence.

| Hook | → state |
|---|---|
| `SessionStart` | `idle` (join; also drains the inbox) |
| `UserPromptSubmit` | `working` (turn starts; drains the inbox) |
| `Notification` (`permission_prompt` / `elicitation_dialog`) | `waiting` (blocked on a human) |
| `Stop` | `idle` (turn done) |
| `StopFailure` | `idle` (turn died on an API error — `Stop` won't fire) |
| `SessionEnd` | `offline` (graceful leave) |

Wired in [`hooks.json`](../extensions/connector-claude-code/hooks/hooks.json), relayed over the connector's
control socket ([`connector-core/src/control.ts`](../extensions/connector-core/src/control.ts)) and mapped to
presence by the Claude handle in [`mcp.ts`](../extensions/connector-claude-code/src/mcp.ts).

## Message delivery (stream-backed)

Peer messages land in the connector's inbox from its **durable JetStream consumers** (per the
DM / chat / task streams in [architecture](architecture.md#technical-mapping-nats--jetstream)),
so a message sent while the agent is busy or offline waits on the stream instead of being lost.

Two things move a message from the inbox to the model — **one delivers, one only wakes**:

- **Hook drain (delivery).** `SessionStart` / `UserPromptSubmit` drain the inbox, inject the
  messages as `additionalContext`, and **ack** them on the stream. This is the single
  authoritative path — gating-free, works on any Claude Code build. A message is acked only here,
  once actually surfaced; a crash before injection redelivers it.
- **Channel nudge (wake).** Each arriving message also fires a content-less
  `notifications/claude/channel` nudge that wakes an *idle* session into a turn, so the hook drain
  runs *now* instead of at the next prompt. The nudge never acks or removes anything — if the channel
  can't run, delivery still happens at the next turn. It takes three things together: the plugin's MCP
  declares the `claude/channel` capability, the session is launched with
  `--dangerously-load-development-channels plugin:swarl@swarl-mesh` (research preview), **and**
  `SWARL_CHANNEL=1`. The last one matters: Claude does not echo `claude/channel` back in its MCP
  client capabilities, so the connector would auto-detect the channel as *off* and never send the
  nudge — the env flag forces it on.

### Once per session
| Event | Fires when | Matchers |
|---|---|---|
| `SessionStart` | a session begins or resumes | `startup`, `resume`, `clear`, `compact` |
| `Setup` | started with `--init-only`, or `--init`/`--maintenance` in `-p` | `init`, `maintenance` |
| `SessionEnd` | a session terminates | `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other` |

### Once per turn
| Event | Fires when | Matchers |
|---|---|---|
| `UserPromptSubmit` | user submits a prompt, before Claude processes it | — |
| `UserPromptExpansion` | a typed command expands into a prompt | command name |
| `Stop` | Claude finishes responding | — |
| `StopFailure` | turn ends due to an API error | `rate_limit`, `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown` |

### Per tool call (agentic loop)
| Event | Fires when | Matchers |
|---|---|---|
| `PreToolUse` | before a tool call executes (can block) | tool name |
| `PermissionRequest` | a permission dialog appears | tool name |
| `PermissionDenied` | a tool call denied by auto-mode classifier | tool name |
| `PostToolUse` | after a tool call succeeds | tool name |
| `PostToolUseFailure` | after a tool call fails | tool name |
| `PostToolBatch` | after a parallel tool batch resolves, before next model call | — |
| `SubagentStart` | a subagent is spawned | agent type |
| `SubagentStop` | a subagent finishes | agent type |
| `TaskCreated` | a task is created via `TaskCreate` | — |
| `TaskCompleted` | a task is marked completed | — |
| `TeammateIdle` | an agent-team teammate is about to go idle | — |

### Compaction
| Event | Fires when | Matchers |
|---|---|---|
| `PreCompact` | before context compaction | `manual`, `auto` |
| `PostCompact` | after compaction completes | `manual`, `auto` |

### Async / background
| Event | Fires when | Matchers |
|---|---|---|
| `CwdChanged` | working directory changes | — |
| `FileChanged` | a watched file changes on disk | literal filenames |
| `ConfigChange` | a config file changes mid-session | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` |
| `InstructionsLoaded` | CLAUDE.md / `.claude/rules/*.md` loaded into context | `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact` |
| `Notification` | Claude Code emits a notification | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response` |
| `MessageDisplay` | while assistant message text is displayed (display-only) | — |

### Worktree
| Event | Fires when | Matchers |
|---|---|---|
| `WorktreeCreate` | a worktree is created (`--worktree` / `isolation: "worktree"`) | — |
| `WorktreeRemove` | a worktree is removed | — |

### MCP elicitation
| Event | Fires when | Matchers |
|---|---|---|
| `Elicitation` | an MCP server requests user input during a tool call | MCP server name |
| `ElicitationResult` | after the user responds, before it's sent to the server | MCP server name |
