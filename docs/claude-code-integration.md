# Claude Code hooks

> Source: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) (Claude Code 2.1.16x — 31 events).

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

Wired in [`packages/connector/hooks/hooks.json`](../packages/connector/hooks/hooks.json),
dispatched in [`packages/connector/src/control.ts`](../packages/connector/src/control.ts).

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
