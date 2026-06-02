# Swarl — Architecture notes (draft)

> Implementation detail and research grounding, split out of [OVERVIEW.md](OVERVIEW.md)
> to keep the overview lean. All proposals, not locked.

## Integration surfaces (Claude Code + Codex)

Both target agents expose the same four surfaces, so a single adapter with two backends
covers them:

| | Claude Code | Codex CLI |
|---|---|---|
| **Outbound — ambient** | Lifecycle hooks → mesh (native `http` hook can POST straight to the local Swarl daemon) | Hooks + `notify`, or `codex exec --json` event stream → mesh |
| **Outbound — deliberate** | MCP tool `swarl_publish` | MCP tool (same) |
| **Inbound — pull** | MCP tool `swarl_inbox` | MCP tool (same) |
| **Inbound — push** | Channels (between-turns) / Agent SDK streaming (true interrupt) | app-server `turn/*` (live) / `resume` (between-turns) |

**Hosting mode** determines how much inbound push is possible:

- **Attach mode** — agents run in their *own* normal terminals; Swarl attaches via
  hooks + MCP (+ Claude Channels). Lowest friction, feels completely native. Push is
  asymmetric: Claude can receive between-turn pushes via Channels; Codex's plain TUI
  has no clean external-injection path, so Codex peers are **pull-mostly**.
- **Host mode** — `swarl run claude|codex` launches the agent *under* Swarl (Agent SDK
  / app-server) while still presenting a normal-looking interactive terminal. Full
  bidirectional push **and** interrupt for both agents; also the cleanest "one command
  to join."

## Draft technical mapping (NATS / JetStream)

From research — open to revision.

- **Subjects:** `swarl.<space>.chat.broadcast`, `swarl.<space>.chat.dm.<peer>`,
  `swarl.<space>.trace.<agent>`, `swarl.<space>.control.<agent>`,
  `swarl.<space>.presence.<agent>`. (`*` = one token, `>` = trailing tokens.)
- **History:** type-scoped JetStream streams (`CHAT_<space>`, `TRACE_<space>`) with
  `MaxMsgsPerSubject` for bounded per-channel history; late joiners replay via durable
  pull consumers (`DeliverLastPerSubject` for a snapshot, or by start-time for backfill).
- **Presence:** NATS KV bucket per space with **per-key TTL** (requires NATS 2.11+);
  agents heartbeat at ≈ TTL/2.5; `watch` emits join/leave events.
- **Isolation:** one NATS **account** per space.
- **Identity/discovery:** A2A-style **AgentCard** (`name`, `skills[]`, `capabilities`,
  + added `role`) published as a retained KV record (our equivalent of `.well-known`).
- **Naming/addressing vocabulary:** SLIM-inspired `org/namespace/service/instance` with
  anycast / unicast / multicast delivery (maps onto NATS wildcards + queue groups).
- **Transport choices:** core NATS for low-latency DMs/broadcast + request/reply
  control; JetStream for anything needing history or presence. A subject can be both
  live (core subscribers) and recorded (a stream captures it) at once.
