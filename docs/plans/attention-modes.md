# Plan: agent-chosen attention modes (`open` / `dnd` / `focus`) + subject-authenticated `kind`

> Status: ready to build. **Build everything at once** (not phased). Reviewed and converged by
> the #review council (fowler/eng, norman/ux, mitnick/sec, socrates/critic, truthium/facts);
> this doc is the self-contained spec — it carries every decision and code reference, so it can
> drive the build without the originating conversation.

## 1. Goal

Let an agent choose how aggressively peer traffic interrupts it, **without** overloading the
presence enum. Two needs, both real:

- **Interruption** — "don't *wake* me for channel chatter unless I'm tagged." → `dnd`.
- **Context pollution** — "don't even let untagged chatter *into my context*; only tagged reaches
  me; I'll pull the rest on demand." → `focus`. (`dnd` does **not** solve this — it still floods
  ambient into context on the next turn.)

A new `attention` mode — `open` (default) / `dnd` / `focus` — orthogonal to `PresenceStatus`
(`idle`/`working`/`waiting`/`offline` are unchanged).

## 2. Decisions (baked in; rationale from the review)

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| F1 | name | `attention: "open" \| "dnd" \| "focus"` | maps to OS notification semantics (on / DND / Focus); no new vocabulary |
| F2 | visibility | **local-only** (not broadcast as presence) | advisory either way (see §7); broadcasting adds a `packages/core` presence field for little v1 gain |
| F3 | lifecycle | **reset to `open` on `SessionStart`** | fail-open availability default — a crashed/restarted agent must not stay silently deaf |
| F4 | focus @-mention | **B: wake-only + pull** (not auto-inject) | `@`-mention is payload-forgeable; auto-injecting it reopens the exact context-pollution / injection surface focus exists to close. B makes auto-injected context *exactly* the broker-authenticated set; a forged mention costs at most a wake. Also uniform (no held-mid-turn-mention buffer). |
| F5 | focus recall semantics | **"ambient since you entered focus"** (per-channel focus-watermark; see §6) | bounded, meaningful, no moving cursor; "N dropped" marker falls out of comparing the focus-watermark to the stream's oldest-retained seq |

These are the converged recommendations. They can be flipped before the build, but the spec below
assumes them.

## 3. Terminology (precise — the whole design keys off this)

- **subject-directed** — a message whose `kind` is `dm` or `anycast`, **derived from the NATS
  subject at the pump** (§5). Unforgeable beyond the sender's own identity (the authenticity guard
  at `endpoint.ts:842` binds payload `from` to the subject sender). This is the *only* trustworthy
  "this was addressed to me" signal.
- **mention** — `mentionsMe === true`. Computed from `m.mentions[]` in the **payload**
  (`agent.ts:154`) — **forgeable** (any peer can put your name in `mentions[]`). It may *wake* you;
  it must never earn subject-directed privilege.
- **ambient** — a channel message with `mentionsMe === false`.

## 4. Behavior matrix

| arrival | `open` (today) | `dnd` | `focus` |
|---|---|---|---|
| subject-directed (dm/anycast) | buffer + wake + inject | buffer + wake + inject | buffer + wake + inject |
| channel `@`-mention | buffer + wake + inject | buffer + wake + inject | **ack-drop**; wake (hint: "mentioned — pull `cotal_inbox`"); **not injected** |
| ambient (channel, no mention) | buffer; wake **if idle**, hold if working; inject next turn | buffer; **never wake**; inject next turn | **ack-drop**; no wake; recall via `cotal_inbox` |

The load-bearing insight (fowler): **in `focus`, ambient and mentions are acked-and-dropped at
ingest — never buffered.** The live in-memory inbox then holds *only* subject-directed messages, so
every downstream path (`drainInbox`, `inboxCount`, the Stop→idle flush) is already correct with no
per-site filtering. This dissolves the whole class of hazards the first design had (MAX_INBOX
eviction loss, ~60s redelivery churn, durable-reap loss, the unfiltered-`mcp.ts:62` leak, a
busy-loop, and the forged-tag eviction attack). It is the "use JetStream natively" rule: ambient
lives on the chat stream (retained), recalled on demand — not hoarded locally.

## 5. The subject-authenticated `kind` fix (prerequisite — fixes a pre-existing bug)

**Pre-existing bug, independent of attention:** an inbox message's `kind` is derived from the
**forgeable payload** (`agent.ts:143`: `m.to ? "dm" : m.toService ? "anycast" : "channel"`). A peer
can publish a normal broadcast to `chat.<self>.<channel>` with payload `{from:self, to:<victimId>}`,
pass the authenticity guard (`endpoint.ts:842` only checks `from` == subject sender), and the
victim's `ingest` classifies it `kind="dm"` → it force-wakes as a DM today. The endpoint **already
computes** the authenticated kind (`parsed.kind`, `endpoint.ts:841/861`) but **drops it** at the
emit (`endpoint.ts:869`, passes only `{historical}`).

Without this fix, "subject-directed" in §3 is unenforceable — directedness would ride a forgeable
field, so no attention tiering is sound. **Fix it as part of this change.**

Changes:
1. **`packages/core/src/types.ts:124`** — extend `MessageMeta`:
   ```ts
   export interface MessageMeta {
     historical: boolean;
     /** Authenticated message class, derived from the delivering subject — NOT payload. */
     kind: "channel" | "dm" | "anycast";
   }
   ```
2. **`packages/core/src/endpoint.ts`** — set `kind` from `parsed.kind` at both emit sites. Map
   `ParsedSubject.kind` (`subjects.ts:141`: `"chat"|"inst"|"svc"|"ctl"`) → message kind:
   `chat → "channel"`, `inst → "dm"`, `svc → "anycast"` (`ctl` is control-plane, never a
   `"message"` emit).
   - `:869` (live pump): `{ historical: false, kind: kindFromParsed(parsed.kind) }`.
   - `:992` (historical/backfill emit): always a chat backfill → `kind: "channel"`.
   - Add a small `kindFromParsed()` helper; per repo convention **throw** on an unexpected parsed
     kind rather than defaulting.
3. **`extensions/connector-core/src/agent.ts:143`** — derive `kind` from `meta.kind` (authenticated),
   not payload:
   ```ts
   const kind: InboxItem["kind"] = meta?.kind ?? /* throw: meta.kind is now required */;
   ```
   `mentionsMe` stays payload-derived (`agent.ts:154`) — it is irreducibly payload, and is only ever
   a wake hint, never a privilege. `m.to`/`m.toService` are no longer consulted for classification.
   - Note: `agent.ts:94` wires `ep.on("message", (m, d, meta) => this.ingest(m, d, meta))` — `meta`
     is already threaded through; only its `kind` field is new.

**Result:** chat-delivered messages are always `kind="channel"`; `dm`/`anycast` exist only when
delivered on the `DM_`/`TASK_` streams (identity-bound). The forged-DM masquerade is closed for
every mode.

## 6. Implementation by area

### 6a. `MeshAgent` — the mode + ingest ack-drop (`extensions/connector-core/src/agent.ts`)

- Add the mode:
  ```ts
  export type AttentionMode = "open" | "dnd" | "focus";
  private _attention: AttentionMode = "open";          // F3: default open
  get attention(): AttentionMode { return this._attention; }
  async setAttention(mode: AttentionMode): Promise<void> { /* see focus-watermark below */ }
  ```
- **`ingest()`** — add the focus ack-drop branch *after* dedup, *before* buffering:
  ```ts
  const kind = meta.kind;                                  // authenticated (§5)
  const mentionsMe = m.mentions?.includes(self) ?? false;
  if (this._attention === "focus" && kind === "channel") {
    delivery.ack();                                        // drop from buffer; stays on the stream
    if (mentionsMe) this.emit("mention-wake", item);       // F4=B: wake hint only, NOT buffered
    return;                                                // ambient: silent
  }
  // else: existing path — push {item, ack}, emit("incoming", item)
  ```
  Acking here does **not** delete the message (chat stream is `RetentionPolicy.Limits`,
  `streams.ts:46`) — it stays retained for recall (§6d).
- Add `directedPendingCount(): number` — count buffered items where `kind ∈ {dm, anycast}` **or**
  `mentionsMe` (used by the Stop→idle flush for `dnd`/`focus`).
- **Focus-watermark (F5 recall):** on `setAttention("focus")`, capture the current frontier seq per
  joined channel (reuse the same frontier the join watermark uses) into a `Map<channel, seq>`. This
  marks "where I started focusing." Clear it when leaving focus. `cotal_inbox` recall (§6d) reads
  from these seqs forward.
- **Invariant comment fix:** the "`drainInbox` is the sole ack site" comments (`agent.ts` near the
  inbox; `mcp.ts:147,187`) are no longer true — focus acks ambient/mentions at ingest. Update them
  to: "ack sites are `drainInbox` (surfaced items) and the focus ingest ack-drop (ambient/mentions
  the agent chose not to receive)."

### 6b. `cotal_status` tool — the arg + self-visibility (`extensions/connector-core/src/tools.ts:180`)

- Add an optional `attention` input:
  ```ts
  attention: z.enum(["open", "dnd", "focus"]).optional()
    .describe("open = receive everything; dnd = don't wake me for untagged channel chatter (it still arrives next turn); focus = only DMs/anycast reach my context, @mentions wake me to pull, untagged chatter is held on the channel — read it with cotal_inbox."),
  ```
- On set, call `agent.setAttention(...)` and **echo the active mode + its meaning** in the tool
  result (norman: self-visibility is the escape hatch for the focus footgun — non-optional). Echo it
  on read too (and include it in the `cotal_roster` self line).
- `status` and `attention` are independent; either may be set without the other.

### 6c. Nudge + flush gate (`extensions/connector-claude-code/src/mcp.ts`)

- **Incoming nudge** (replaces the `agent.on("incoming")` gate at `mcp.ts:168-171`):
  ```ts
  agent.on("incoming", (item) => {
    const directedOrMention = item.kind !== "channel" || item.mentionsMe;
    const ambientWakes = agent.attention === "open" && agent.status !== "working";
    if (directedOrMention || ambientWakes) nudge(item);
  });
  ```
  - `open`: ambient wakes if idle, suppressed while working (today's behavior, preserved).
  - `dnd`: ambient buffered but `ambientWakes` is false → never wakes; directed/mention wake.
  - `focus`: ambient/mentions never reach `"incoming"` (ack-dropped at ingest); only directed does → always nudges.
- **Mention-wake (focus only):**
  ```ts
  agent.on("mention-wake", (item) => nudge(item, /* hint */ "you were mentioned — pull cotal_inbox"));
  ```
  The nudge content for a focus mention must say *pull* (the message is not in the buffer).
- **Stop→idle flush** (`mcp.ts:89`, `if (agent.inboxCount() > 0) agent.requestWake();`) → make the
  predicate mode-aware:
  ```ts
  const pending = agent.attention === "open" ? agent.inboxCount() : agent.directedPendingCount();
  if (pending > 0) agent.requestWake();
  ```
  - `open`: wakes to flush any held ambient (today's behavior — do **not** regress this).
  - `dnd`: wakes only for held directed/mention; ambient waits for the next natural (human) turn,
    then rides the unfiltered drain. Avoids the empty-wake busy-loop (`inboxCount()` would stay >0
    forever with parked ambient).
  - `focus`: buffer holds only directed → `directedPendingCount()` == `inboxCount()`.
- **The UserPromptSubmit drain stays unfiltered** (`mcp.ts:62`, `formatInjection(agent.drainInbox())`).
  No change needed: the buffer already reflects the mode (focus ack-dropped ambient/mentions at
  ingest), so `drainInbox()` naturally injects directed-only in focus, everything in open/dnd.
- **`SessionStart`** (`mcp.ts:52`): F3 — explicitly reset `attention` to `open` (it's already the
  constructor default, but reset on every SessionStart so a reused agent process starts open).

### 6d. `cotal_inbox` focus recall (`extensions/connector-core/src/tools.ts:90` + `agent.ts`)

- `open`/`dnd`: unchanged — drain/peek the live buffer.
- `focus`: the buffer holds only directed, so `cotal_inbox` must *additionally* surface the ambient +
  mentions that were ack-dropped, by reading channel history on demand:
  - For each joined channel, **reuse the existing backfill path** (`endpoint.ts:495 backfillArmed` /
    `~945 backfillChannel`) starting from the channel's **focus-watermark** (§6a), reading forward to
    the current frontier.
  - **Replay-gated (hard requirement, mitnick):** recall must go through the *same* per-channel
    replay gate the join-backfill uses (`channelReplay` / `backfillArmed` only reads when
    `policy.replay`, `endpoint.ts:923`). On `replay=off` channels, recall returns nothing — otherwise
    focus silently becomes a `replay=off` **history bypass**, and chat has **no broker-level ACL
    backstop** (`allow_direct:true`, `streams.ts:53`), so this app gate is the *entire* boundary.
  - Mark recalled items as recall/`historical` (so the agent reads them as catch-up, not live).
  - **"N dropped" marker (never-silent):** if a channel's focus-watermark is older than the stream's
    oldest-retained seq (the 1000/subject `DiscardPolicy.Old` horizon, `streams.ts:48-49`), some
    ambient was discarded off the stream — surface a one-line "N older messages dropped" note rather
    than silently returning a short window.
  - Expose a thin agent method (e.g. `recallAmbient(): Promise<InboxItem[]>`) so the tool stays a
    thin client.

### 6e. Docs (same change — keep docs from drifting)

- **`docs/claude-code-integration.md`** (delivery/presence section): add the attention modes, the
  §4 behavior matrix, the F4=B mention semantics, and the §7 advisory-not-security caveat. Note
  `cotal_inbox` changes meaning in focus (live buffer → channel recall).
- **`docs/architecture.md`**: document the subject-authenticated `kind` (§5) as the message-class
  source of truth, and the attention model as a local delivery preference (not a wire/presence
  field — F2).
- Attention is **local** (F2) → the only `packages/core` change is `MessageMeta.kind` (§5); no
  presence/gossip surface.

## 7. Security model & caveats (state these in the docs)

- **Attention is advisory UX, not a security/cost/authz boundary.** `@`-mention waking is
  irreducibly forgeable (payload is payload); any peer can wake a `dnd`/`focus` agent by naming it.
  Net effect of `focus` is a *reduction* of the untrusted-ambient prompt-injection surface (from
  "any ambient body auto-injected" to "only subject-authenticated dm/anycast auto-injected" under
  F4=B), **not** elimination.
- **`replay=off` is a cooperative/app-level control, not a hard confidentiality guarantee.** Chat
  history is already `allow_direct`-gettable by anyone with chat read perms; focus-recall just adds a
  sanctioned in-product path that **must** honor the replay gate (§6d). Truly-secret channel history
  is a stream-level decision (separate stream / tighter retention / per-subject perms), out of scope
  here.
- The `kind` fix (§5) is what makes "only real DMs auto-inject / can't be evicted" actually true;
  without it the privilege rides a forgeable field.

## 8. Residual limits (by design — call them out, don't hide them)

- **`focus` recall is volume-bounded, not loss-free:** ambient lives on the chat stream under
  `max_msgs_per_subject: 1000` + `DiscardPolicy.Old` (`streams.ts:48-49`), so only ~the last 1000
  ambient *per channel* are recallable; older is discarded server-side. The "N dropped" marker (§6d)
  is the never-silent treatment. (Far better than the rejected local-ring design, which was lost on
  restart and had its own silent cap.)
- Recall survives MCP reconnect (data is on the stream, independent of consumer/inbox state) — but
  the focus-watermark is in-memory, so a reconnect resets recall to "since reconnect" for that
  session. Acceptable.

## 9. Verification (add smoke coverage)

Extend the smoke tests (`packages/core/*.smoke.ts` patterns; add a connector-level smoke if needed):
1. **`kind` authentication:** publish a broadcast to `chat.<self>.<ch>` with payload `{to:victimId}`
   → victim classifies it `kind="channel"`, **not** `"dm"` (regression test for the §5 bug).
2. **`dnd`:** ambient arriving while idle does **not** nudge; it is present in the next
   `drainInbox()`. A dm/anycast/mention **does** nudge.
3. **`focus`:** ambient is acked-and-not-buffered (`inboxCount()` unchanged); a channel `@`-mention
   wakes (mention-wake) but is **not** in `drainInbox()`; a dm/anycast **is** buffered + injected;
   `cotal_inbox` recall returns the ambient from the channel stream, replay-gated (returns nothing on
   a `replay=off` channel).
4. **No busy-loop:** in focus/dnd with only ambient parked/held, Stop→idle does **not** wake.
5. **F3:** a fresh `SessionStart` reports `attention=open`.

## 10. Out of scope (explicitly not doing)

- Broadcasting attention as presence (F2 = local-only).
- A moving "unread-since-pull" recall cursor (F5 = focus-watermark; revisit only if "since you
  focused" proves wrong).
- Any per-subject ACL / separate-stream confidentiality for channels (§7) — a stream-config
  decision, not an attention-mode feature.
- Codex connector: pull-only, no push/hooks, so attention is a no-op there (`cotal_inbox` already
  drains all). One line in its docs; no code.

## 11. Build shape (for the ultracode run)

Roughly parallelizable, with `kind` (§5) landing first since everything keys off `meta.kind`:
1. **Core `kind` fix** (§5): `types.ts` + `endpoint.ts` (both emit sites) + `agent.ts:143`. Gate:
   smoke test #1 green.
2. **Mode plumbing** (§6a, §6b): `attention` field, `setAttention`, focus-watermark,
   `directedPendingCount`, ingest ack-drop branch, `cotal_status` arg + echo.
3. **Gates** (§6c): nudge gate, mention-wake, mode-aware Stop→idle flush, SessionStart reset.
4. **Recall** (§6d): `recallAmbient` over replay-gated backfill + "N dropped" marker; `cotal_inbox`
   focus branch.
5. **Docs** (§6e) + **smoke** (§9), in the same change.
