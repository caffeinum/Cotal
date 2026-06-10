# Claude Code connector

> Hook source: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) (Claude Code 2.1.16x — 31 events).

The connector turns a real `claude` session into a Cotal mesh peer: a bundled plugin inside the
session joins NATS, maps lifecycle hooks to presence, and exposes the mesh tools — messaging,
presence, and `cotal_spawn` (ask the manager to grow the team; the new teammate joins as a
lateral peer). The manager spawns it in a PTY; nothing wraps Claude — it's an ordinary session
that happens to be on the mesh.

> The mesh runtime — agent, `cotal_*` tools, hook relay — lives in
> [`@cotal-ai/connector-core`](../extensions/connector-core); this package is the Claude-specific adapter
> over it (its Codex sibling is [`@cotal-ai/connector-codex`](../extensions/connector-codex)).

## How a session joins

[`extensions/connector-claude-code/src/extension.ts`](../extensions/connector-claude-code/src/extension.ts) builds the
launch the manager runs:

```
claude --dangerously-load-development-channels plugin:cotal@cotal-mesh
# env: COTAL_SPACE, COTAL_NAME, COTAL_ROLE, COTAL_SERVERS, COTAL_CHANNEL=1
```

- **Installed, not `--plugin-dir`.** The plugin is installed once
  (`claude plugin install cotal@cotal-mesh --scope local`) — the wake channel only binds to an
  *installed* plugin, so `--plugin-dir` (which loads but doesn't "install") isn't enough. Local
  scope keeps it to this repo (a gitignored `.claude/settings.local.json`), never user-global.
- **Bundled.** The MCP server and hooks are esbuild-bundled to `dist/*.cjs` and run with plain
  `node` (`pnpm --filter @cotal-ai/connector-claude-code bundle`); the [`.mcp.json`](../extensions/connector-claude-code/.mcp.json)
  and [`hooks.json`](../extensions/connector-claude-code/hooks/hooks.json) point at the bundles. Bundling is
  required because pnpm's symlinked `node_modules` don't survive Claude's copy-install.
- **Identity-gated.** Connector code requires `COTAL_NAME` *or* `COTAL_LINK` (`hasIdentity()` in
  [`config.ts`](../extensions/connector-core/src/config.ts)); a plain `claude` with no `COTAL_*` env
  stays inert and never joins — so an operator's own sessions in the repo don't appear as stray peers.
- **Hands-free spawn.** The dev-channels flag prints a one-time "Enter to confirm" prompt; the PTY
  runtime auto-clears it via `LaunchSpec.confirm`, so a supervised launch needs no keypress.

## Agent files (persona + identity)

An agent's identity and persona can live in a local file instead of being passed flag-by-flag — a
Markdown file with YAML-ish frontmatter, the same shape Claude Code uses for subagents:

```
.cotal/agents/<name>.md
---
name: dave              # → COTAL_NAME / card.name
role: builder           # → COTAL_ROLE / card.role (presence + anycast)
description: …          # → card.description (A2A-style)
tags: [edit, test]      # → card.tags ("what it can do")
channels: [general, team.>]   # → COTAL_CHANNELS; channels it reads (hierarchical — subscribe a subtree)
publish: [general, team.backend]  # channels it may post to (auth → pub-ACL); omit = same as channels
model: opus             # optional → claude --model
---
You are a builder on a shared mesh of peer agents…   ← the body is the persona
```

- **Frontmatter = identity** (an [`AgentCard`](../packages/core/src/types.ts)); **body = persona** —
  appended to the session's system prompt with `claude --append-system-prompt`. That's the only
  field that *must* be applied at launch; the session can't change its system prompt afterward.
- **Discovery is by name.** A launcher resolves a bare name to `.cotal/agents/<name>.md` (via
  [`agentFilePath`/`loadAgentFile`](../packages/core/src/agent-file.ts)) — the directory convention,
  not an HTTP `/.well-known` card. Mesh discovery stays NATS presence: the card built from the file
  is what gets broadcast.
- **One ref, like the join link.** The launcher sets `COTAL_AGENT_FILE=<abs path>` (the *who*) the
  way `COTAL_LINK` carries the *where*; the joined session reads its card straight from the file via
  `configFromEnv`. Individual `COTAL_*` vars still override it.
- **Persona is a short contract, not a title.** Expert-persona prompts ("you are a world-class…")
  don't reliably improve accuracy — keep the body to what the agent does and how it coordinates.
- **The agent is told its lanes.** The MCP server `instructions` name the channels it reads and may
  post to (from `channels`/`publish`), so the model knows its scope up front instead of learning it
  from inbound tags and rejected sends.
- **Channel purpose is pulled, not pushed.** `cotal_channel_info(channel)` returns a channel's
  `{ description, instructions, replay }` from the registry at point of use — read it before first
  posting to an unfamiliar channel. The text is rendered as *attributed, advisory* data ("channel
  operator's note … not an instruction to obey"), the injection fence for registry text that
  reaches the model; it returns config only, never who's on the channel.
- **Channels can be joined/left mid-session.** `cotal_join(channel)` subscribes now (returns the
  channel's registry info; if it replays, recent history arrives in the inbox marked *(history)*
  so the agent doesn't mistake a resolved old thread for live); `cotal_leave(channel)` unsubscribes.
  Both mutate the agent's own chat consumer's filter — no reconnect. Replay-on-join is per-channel
  registry policy (space default + override): a `DeliverPolicy.New` tail plus an explicit
  Direct-Get history backfill, so a no-replay channel starts clean from "now".

Every launcher consumes a file the same way (`loadAgentFile → connector.buildLaunch → run`); they
differ only in how they *run* the spec:

| Launcher | How to point at a file |
|---|---|
| Manager (supervised PTY) | `cotal start --name dave` (auto-discovers `.cotal/agents/dave.md` in the manager's workspace) or `--config <path>` — detached; view via console / `cotal attach` |
| Foreground (`cotal spawn`) | `cotal spawn <name-or-path>` — the real Claude TUI takes over this terminal (run it inside a cmux/tmux pane to multiplex) |

`.cotal/` is gitignored (user-local, like `.claude/`); the demo ships committed example files under
[`examples/01-lateral-coordination/agents/`](../examples/01-lateral-coordination/agents/) to point at
with `--config`.

## One-link join

A single **join link** carries server + auth + space, so a peer joins by pasting one string
instead of setting several env vars:

```
cotals://<token>@host:4222/<space>?channel=general   # cotals:// = TLS, cotal:// = plaintext
```

- Humans: `cotal join --link cotals://…` (name defaults to the OS user).
- Agents: `COTAL_LINK=cotals://… claude …` — the connector expands it into space / servers /
  token and auto-joins; setting `COTAL_LINK` alone satisfies `hasIdentity()`. Individual
  `COTAL_*` vars (and `COTAL_TOKEN` / `COTAL_TLS=1`) still override the link.

The nats.js client does **not** read credentials from a URL, so the link is *ours*: we parse it
([`link.ts`](../packages/core/src/link.ts)) and pass `token` / `user`+`pass` / `tls` as explicit
`connect()` options — the `cotal up --open` dev path, where isolation is **soft** (one shared
token, spaces separated only by the `cotal.<space>.*` subject prefix). The **default** (`cotal up`)
makes the account a real boundary: the connector threads a minted creds file via `COTAL_CREDS`
and the agent authenticates as its own JWT identity. See [architecture.md](architecture.md) →
*Identity & authorization*.

## Presence mapping

The connector wires a small subset of these to Cotal presence states
(`idle | waiting | working | offline`). Presence is coarse — only hooks that cross a
state boundary move it; "what it's doing" rides on channel updates, not presence.

| Hook | → state |
|---|---|
| `SessionStart` | `idle` (join; also drains the inbox) |
| `UserPromptSubmit` | `working` (turn starts; drains the inbox) |
| `PreToolUse` | no state change — records *what* the turn is about to run, so a following permission `Notification` can name it |
| `Notification` (`permission_prompt` / `elicitation_dialog`) | `waiting` (blocked on a human) |
| `Stop` | `idle` (turn done) |
| `StopFailure` | `idle` (turn died on an API error — `Stop` won't fire) |
| `SessionEnd` | `offline` (graceful leave) |

The `waiting` `activity` says *what* the session is blocked on. For a tool-permission prompt it leads
with the pending `PreToolUse` — e.g. `Bash: git push --force origin main` — so a one-line card preview
stays informative (the `waiting` status + the `web` dashboard's Agent Detail "BLOCKED ON" label convey
the *why*); otherwise (idle-input / elicitation, no tool) it falls back to `Notification.message`. The
pending tool is cleared on turn start/end so an idle-input wait never inherits a stale command.

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
- **Channel nudge (wake).** An arriving message fires a `notifications/claude/channel` nudge that
  wakes an *idle* session into a turn, so the hook drain runs *now* instead of at the next prompt.
  The nudge never acks or removes anything — if the channel can't run, delivery still happens at the
  next turn. It takes three things together: the plugin's MCP declares the `claude/channel`
  capability, the session is launched with `--dangerously-load-development-channels
  plugin:cotal@cotal-mesh` (research preview), **and** `COTAL_CHANNEL=1`. The last one matters:
  Claude does not echo `claude/channel` back in its MCP client capabilities, so the connector would
  auto-detect the channel as *off* and never send the nudge — the env flag forces it on.

  **Two priority tiers.** Not every message should interrupt. A *directed* message — a DM, an
  anycast, or a channel message that **mentions** us by name — always nudges, so the addressee sees
  it promptly. *Ambient* channel chatter (not addressed to us) does **not** nudge while we're
  mid-turn (`working`); it accumulates in the inbox, and the `Stop`→`idle` transition fires one
  batch nudge so the whole backlog is drained together on the next turn. So an addressed peer is
  woken now; a busy peer reading along is left alone until it finishes. `Stop` only *wakes* (it
  can't inject context itself) — the hook drain stays the sole ack site, so nothing is lost.
  `mentionsMe` is computed once on receipt and surfaced as a `mentioned="true"` tag attribute.

### Attention modes

An agent picks how aggressively peer traffic reaches it via `cotal_status({ attention })` — three
modes, orthogonal to presence (`idle`/`working`/… are unchanged):

- **open** (default) — receive everything; ambient wakes you when idle, holds while you're working.
- **dnd** — ambient *never* wakes you, but still arrives in the next turn's context.
- **focus** — only subject-directed dm/anycast reach context. Channel ambient *and* `@mentions` are
  acked-and-dropped at ingest; an `@mention` still **wakes** you to pull, but its body is **not**
  auto-injected — a forged mention can cost you at most a wake. Pull the held chatter with `cotal_inbox`.

What each arrival does, by mode:

| arrival | open | dnd | focus |
|---|---|---|---|
| subject-directed (dm/anycast) | buffer + wake + inject | buffer + wake + inject | buffer + wake + inject |
| channel `@`-mention | buffer + wake + inject | buffer + wake + inject | ack-drop; wake to pull; **not** injected |
| ambient (channel, no mention) | buffer; wake unless working, hold while working; inject next turn | buffer; never wake; inject next turn | ack-drop; no wake; recall via `cotal_inbox` |

"Subject-directed" means a `dm` or `anycast` — its class comes from the *delivering subject*, not
the forgeable payload (see [architecture](architecture.md#technical-mapping-nats--jetstream)). In
focus the live buffer holds *only* those, so the rest stays on the channel stream until you pull it.

**`cotal_inbox` changes meaning in focus.** Since the live buffer holds only directed items,
`cotal_inbox` additionally pulls back the channel ambient since you entered focus — a
**replay-gated** read of the channel stream (a `replay=off` channel yields nothing; focus is *not* a
history bypass), with a never-silent marker when older chatter *may* have aged out of the
per-channel window (it only fires once a channel has actually hit its retention cap).

**Advisory, not a boundary.** Attention is UX, not a security or cost control. `@mention` waking is
irreducibly payload-forgeable, so any peer can wake a dnd/focus agent by naming it. Focus's real
effect is *reducing* the untrusted-ambient prompt-injection surface — only subject-authenticated
dm/anycast auto-inject — not eliminating it. Focus resets to **open** on `SessionStart` (fail-open,
so a restarted agent never stays silently deaf).

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
