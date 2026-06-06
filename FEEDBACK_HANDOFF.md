# Feedback feature — handoff / continuation

A protocol-native **feedback channel** lets any agent (or a human via an agent) report issues
over the Swarl mesh. **Phase 1 (the mesh side) is built, tested, and committed.** Phase 2
(surfacing feedback in the `SWARL-hosted` dashboard via a Vercel cron that pulls from the broker
into Neon) is **designed and ready to build**. This doc is the handoff so anyone can continue.

> The feedback/auth code is **not in this PR** — it's already committed on branch
> `licensing-apache-2` (it sits on top of the demo/connector chain and can't cleanly split onto
> `main`). This PR is just the written handoff. Commit refs below point at that branch.

## Where the code lives (branch `licensing-apache-2`)

- `e5910f4` feat(feedback): protocol-native feedback channel + `swarl_feedback` tool
- `2d5959f` feat(core): optional NATS auth via `SWARL_NATS_*` (token/creds/user-pass)
- `9851d2e` refactor(core): lift `MeshAgent` + `configFromEnv` into core (the `feedback()`
  method moved with it — now in `packages/core/src/mesh.ts`)
- `9c53c5a` fix(agents): … shared feedback const

---

## ✅ DONE — Phase 1 (mesh side)

### Feedback channel + tool
- **Reserved channel** `FEEDBACK_CHANNEL = "feedback"` + **`FeedbackReport`** type — defined
  once in core: `packages/core/src/subjects.ts`, `packages/core/src/types.ts`.
- **`swarl_feedback` MCP tool** — `extensions/connector/src/mcp.ts`. Input
  `{ message, source: "agent"|"human", severity? }`. Publishes a `multicast` to `#feedback`
  carrying a structured `data` part (a `FeedbackReport`) — **no new message kind**.
- **Auto-classification** `classifyOrigin(cwd) → { domain, component }` — walks up to the nearest
  `package.json`; `packages/*` → `protocol`, else `implementation`; package name = `component`.
  `extensions/connector/src/feedback.ts` (+ `feedback.test.ts`).
- `feedback` added to the connector's **default channels**; `MeshAgent.feedback()` lives in core.
- **Durable + observable for free**: feedback rides the CHAT JetStream stream (1000/channel
  backlog, replays on join), visible live in `swarl console` / `swarl watch`.
- **Docs**: `docs/claude-code-integration.md` (tool table), `docs/architecture.md` (reserved
  channel as a protocol convention).
- ✅ `pnpm typecheck`, `pnpm --filter @swarl/connector test`, `pnpm smoke` all green.

### NATS auth plumbing
- **`NatsAuth` + `natsAuthFromEnv()`** in `packages/core/src/endpoint.ts`. Endpoints **and**
  `isReachable()` default to reading `SWARL_NATS_TOKEN` / `SWARL_NATS_CREDS` /
  `SWARL_NATS_USER`+`PASS` — so every surface (connector, manager, CLI, examples) inherits auth
  with no per-call-site wiring; **anonymous stays the default**.
- `swarl up --token <t>` (or `SWARL_NATS_TOKEN`) starts a token-guarded `nats-server`;
  `examples/02-cmux-handoff/run-agent.sh` forwards `SWARL_NATS_*` to spawned agents.
- ✅ **Verified live** against a token-protected `nats-server`: anon rejected, token connects,
  presence KV works under auth, wrong token rejected.

### Using it today
An agent calls `swarl_feedback({ message, source })` → the report lands on `#feedback`, durable
and visible in `swarl console`. Identity (`from.name/role`), `space`, `ts` ride on the envelope;
`source` / `domain` / `component` / `severity` / `message` are in the `FeedbackReport` data part.

---

## ⏳ TODO — Phase 2 (surface feedback in the `SWARL-hosted` dashboard)

**Host** = the separate repo `SWARL-hosted` (Next.js 16, currently a landing-page visualization;
no API/DB/auth yet). **Another agent is actively working there — coordinate before building; do
not clobber its in-flight work.**

### Locked decisions
- **Transport = Pull (cron).** A Vercel **cron** in `SWARL-hosted` connects to the broker (NATS
  creds), reads new `#feedback` via a **durable consumer** (server-side cursor → nothing missed),
  writes to Neon, disconnects. **No always-on collector, no public ingest endpoint, no signing.**
- **Auth for the read = NATS creds only** (token now; per-user `.creds`/JWT later). The pull model
  needs no HMAC/bearer.
- **Contract** = the `FeedbackReport` shape (single source of truth: `@swarl/core`) on channel
  `#feedback` → subject `swarl.<space>.chat.feedback`, stream `CHAT_<space>`.

### Build steps (in `SWARL-hosted`, coordinated with its agent)
1. **NATS read** — either import `@swarl/core` and run a short-lived
   `SwarlEndpoint({ channels:["feedback"], consume:true, registerPresence:false, watchPresence:false })`,
   **or** a lighter raw `nats` client + the documented envelope (no `@swarl` dep). Decide during
   contract sync. (`@swarl/core` isn't published — git dep / vendor / publish if importing it.)
2. **Neon + Drizzle** `feedback` table mirroring `FeedbackReport`
   (`source` enum, `domain` enum, `component`, `severity` enum, `message`, plus `from`/`space`/`ts`).
3. **Cron route** that pulls new feedback (durable-consumer name persists the cursor across runs)
   and upserts into Neon.
4. **Neon Auth (Stack)** on a new `/dashboard` route to list/filter; the landing visualization stays.
5. **Env**: NATS connection + creds, `DATABASE_URL`, Vercel cron schedule.

### Deferred — separate workstream
**Public broker auth** before external users can connect: multi-tenant NATS (accounts +
per-user/team JWT `.creds`, subject perms scoped to `swarl.<space>.>` **plus** the presence KV
`$KV.swarl_presence_<space>.>`, `$JS.API.>`, `_INBOX.>`). Feedback is built against your own
authed broker first.

---

## Notes / gotchas
- Agents currently **join `#feedback` by default**, so a feedback broadcast lands in every agent's
  inbox and can wake an idle one (channel nudge). Fine at low volume; scope to the console/collector
  if it gets noisy.
- NATS **permissions**, when used, must also allow the presence KV + `$JS.API.>` + `_INBOX.>`, or
  presence / durable consumers / request-reply break silently.
- The console renders a `data` part as `JSON.stringify` in the feed — optional light renderer polish.

## Verify the done parts
- `pnpm typecheck` · `pnpm --filter @swarl/connector test` · `pnpm smoke`
- Live: `pnpm swarl up` + `swarl console --space todo`; from a worker call `swarl_feedback` → it
  appears on `#feedback`. Auth: `swarl up --token X` then `SWARL_NATS_TOKEN=X` for clients.
