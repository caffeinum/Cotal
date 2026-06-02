# Swarl — Architecture notes (draft)

> Implementation detail and research grounding, split out of [OVERVIEW.md](OVERVIEW.md)
> to keep the overview lean. All proposals, not locked.

## Influences: A2A + SLIM

Swarl borrows vocabulary and shapes from two agent frameworks so we stay interoperable
rather than siloed — but implements them over NATS/JetStream.

**From A2A** — the *data shapes*: `AgentCard` (identity / role / capabilities / skills),
`Message` / `Part` (text & data), `Artifact`, and correlation ids (`contextId`). We do
**not** adopt A2A's HTTP/JSON-RPC transport, `Task` RPCs, or its request/response server
model — those don't fit lateral pub/sub.

**From SLIM** — the *addressing and delivery model*:
- **Hierarchical address** `space / service / instance` (SLIM's `org/namespace/service/
  instance`). In Swarl: `space` = the collaboration; `service` = the addressable class
  (a role / agent-type, e.g. `reviewer`); `instance` = one specific endpoint.
- **Three delivery modes:** **multicast** (to a channel — everyone), **unicast** (to one
  instance), **anycast** (to *any one* instance of a service — delegation / load-balancing).
- **Sessions + moderator** (managed groups with admit/remove) — *deferred*, but the design
  leaves room for it; channels are open for now.

We do **not** adopt SLIM's Rust data plane, gRPC transport, or MLS encryption — NATS/
JetStream replaces that layer and adds the durability + presence SLIM leaves to the app.

**Identity** is an A2A `AgentCard` whose `instance` id is a throwaway UUID today, shaped
to later become a **DID** (`did:key` — a self-certifying public-key identifier) so identity
can be cryptographically verifiable and decentralized (see *Deferred*).

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

## Technical mapping (NATS / JetStream)

**Status:** implemented = multicast (channels), unicast (direct), presence with states.
Next = the SLIM addressing pass: add **anycast** (`svc.<service>` queue groups), rename the
unicast subject `dm`→`inst`, add `service` to the address. Later = trace/control families, history.

- **Subjects (delivery modes):**
  - multicast → `swarl.<space>.chat.<channel>`  — broadcast to a channel
  - unicast → `swarl.<space>.inst.<instance>`  — one specific endpoint *(currently `dm.<id>`)*
  - anycast → `swarl.<space>.svc.<service>`  — subscribers join NATS **queue group**
    `<service>`, so one publish reaches exactly one instance *(next)*
  - trace → `swarl.<space>.trace.<instance>`, control → `swarl.<space>.control.<instance>` *(later)*
  - `*` = one token, `>` = trailing tokens; `swarl.<space>.>` taps everything (the `watch` command).
- **Presence:** NATS **KV bucket per space** (key = instance id), bucket-level TTL + a
  client-side expiry sweep (correct without relying on server delete-markers). States:
  `idle` / `waiting` / `working` / `offline`. Heartbeat ≈ TTL/3; graceful leave publishes a
  final `offline`; a lapsed heartbeat is swept to `offline`. Offline peers stay in the roster.
- **Identity/discovery:** A2A `AgentCard` (`id`=instance, `name`, `role`≈service, `kind`,
  `capabilities`, `skills`) carried in the presence record (our equivalent of `.well-known`).
- **Message envelope:** `{ id, ts, space, from:{id,name,role}, to?, channel, parts[],
  replyTo?, contextId? }`, JSON on the wire. `to` set = unicast; absent = channel.
- **History:** type-scoped JetStream streams (`CHAT_<space>`) with `MaxMsgsPerSubject`;
  late joiners replay via durable pull consumers — *later* (chat is fire-and-forget today).
- **Isolation:** one NATS **account** per space (later: split `space` into `org/namespace`).
- **Transport choice:** core NATS for live multicast/unicast/anycast + request/reply
  control; JetStream for presence (KV) and history.

## Deferred (designed-for, not built)

- **Sessions + moderator** — managed group membership (admit/remove), per SLIM's Group session.
- **Verifiable identity** — `instance` becomes a `did:key`; messages signed, peers verify.
- **Message history / late-join replay** — the JetStream streams described above.
