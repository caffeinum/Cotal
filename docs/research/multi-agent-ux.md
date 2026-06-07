# Multi-Agent UX — Research & Design Principles for Cotal

> How a single human stays aware of, and in control of, many autonomous agents
> coordinating in real time — without being overwhelmed. A synthesis of human-AI
> interaction research and current (2024–2026) agent tooling, mapped onto Cotal's
> primitives and implementation. Companion to [OVERVIEW](../OVERVIEW.md) and
> [architecture](../architecture.md). Sources are listed at the end.

## Why this exists

Cotal is a **lateral peer mesh**: agents join a shared space and coordinate as peers,
not as nodes under an orchestrator. That makes the *human's* role unusual — not a
controller at the top of a tree, but an **observer and occasional steerer** standing
beside a swarm that mostly runs itself. The central UX problem follows directly:

> **One human, many autonomous peers, all moving at once.** Attention is the
> bottleneck. The interface has to give a constant, trustworthy picture and a cheap way
> to intervene — while ruthlessly protecting the human from noise.

Everything below serves that. The through-line from the research is that **trust is the
binding constraint** for AI products in 2026, and trust is built from four things:
*transparency, control, consistency, and graceful failure* (NN/g). Lose any one and the
human either over-trusts (misses failures) or under-trusts (ignores the system).

Three questions the human is *always* asking — borrowed from situational-awareness
research and used as the organizing spine of this doc:

1. **What's happening now?**
2. **What changed?**
3. **What needs me?**

A good Cotal surface answers all three at a glance, and lets the human drill from any of
them into detail without losing context.

---

## Part 1 — Principles from the research

Each principle states the finding, its strongest sources, and the **→ Cotal** implication.

### A. Make every agent and action legible

- **State what each agent can do and how reliable it is — up front.** Microsoft's
  *Guidelines for Human-AI Interaction* (G1 "make clear what the system can do", G2 "…how
  well") and Google PAIR's *Mental Models* chapter both put expectation-setting first:
  an accurate mental model is what calibrates trust. Apple's HIG echoes it ("set clear
  expectations about what your AI feature can and can't do").
- **Disclose AI presence and attribute every action.** IBM's design ethics is blunt —
  *"imperceptible AI is not ethical AI"*; the user should always know they're dealing
  with an agent, and Carbon's **AI label** marks every AI-generated element as a
  consistent pathway to "why did this happen". Microsoft G11 ("make clear why the system
  did what it did") was one of the most-violated guidelines in their study.
- **Explanations succinct and in-flow; depth on demand.** PAIR and Apple both push the
  *why* inline and short, with progressive disclosure for the full rationale.

→ **Cotal.** Every peer already carries an A2A-style **AgentCard** (name, role, `tags`,
description). Treat that card as the legibility contract: the dashboard should show *who*
acted, *in what role*, and — the gap today — *why* and *on whose behalf*. Per-message
attribution (`from`, role) exists; per-action **intent/rationale** does not yet.

### B. Don't overload — fewer, better signals

- **Noise destroys the signal.** The healthcare **alarm-fatigue** literature (Joint
  Commission Sentinel Event Alert 50; AHRQ) is the cautionary tale: when 80–99% of
  alarms are non-actionable, clinicians desensitize and miss the real ones. The same
  failure kills ops dashboards and will kill an agent feed.
- **Gate interrupts behind "urgent + actionable + user-visible."** Google SRE's rule:
  if an event doesn't need human action, it goes to a log/dashboard, not an interrupt.
- **Tier by severity; only the top tier interrupts.** Apple's four interruption levels
  (*Passive / Active / Time-Sensitive / Critical*) and Android's importance channels are
  the proven model. Reserve sound/animation/breakthrough for "a human is needed now".
- **Progressive disclosure.** (Nielsen / NN/g.) Default to a summarized, collapsed view;
  reveal raw detail on request. Directly attacks *extraneous* cognitive load (Sweller)
  and respects chunking limits (Miller).
- **Batch, digest, defer-to-breakpoint.** Coalesce low-priority chatter into periodic or
  interruption-aware digests; time non-critical interrupts to natural task breakpoints
  (Adamczyk & Bailey) — the ~23-minute refocus cost (Mark) is real.
- **Calm defaults + tunable control.** Slack's notification rebuild defaults to
  *mentions + DMs*, decouples *what* to notify from *how*, and makes it all per-channel
  tunable. Control is what lets one human scale across many sources.

→ **Cotal.** A raw `tap` of the whole mesh (what `watch` and the web feed do today) is
the *firehose*, useful but not the default lens. Cotal needs severity tiers, a quiet-by-
default posture, per-agent/per-channel mute & filter, and digesting — see R6–R8.

### C. Give a clear overview at all times (situational awareness)

- **Design for all three SA levels (Endsley).** *Perception* (the elements), then
  *comprehension* (what they mean together — "three idle + one queue backing up = the
  pipeline is stalled", not five raw counters), then *projection* (near-future — "blocked
  4 min", "queue overflows in ~5 min"). ~76% of SA errors are *perception* failures, so
  glanceability is job one — but comprehension/projection are what prevent surprises.
- **Overview first, zoom and filter, details on demand** (Shneiderman's mantra). The
  always-on overview *is* the situational-awareness surface; everything else is a
  drill-down that doesn't change the surrounding context.
- **Glanceability + calm technology.** Use pre-attentive cues (color *and* shape/position;
  never color alone) so change pops out with near-zero effort (Matthews et al.). Keep the
  display quiet when idle and escalate to the periphery only when needed (Weiser's calm
  tech) — awareness *without* constant attention.
- **Golden signals + a "needs me" lane.** Borrow Google SRE's at-a-glance health (map to
  agents: active / blocked / errored / oldest-unattended) and give "items requiring the
  human" their own high-priority real estate, with strict alarm discipline.

→ **Cotal.** The new `cotal web` dashboard is the natural home for this. Today it shows
presence + channels + a live feed (perception). It lacks the *comprehension* band
(system-wide golden-signal tiles), a *projection* layer (aging timers), and a dedicated
**"needs you"** lane — see R1–R4.

### D. Transparency and control — calibrated trust, not maximal trust

- **Calibrate, don't maximize.** (Lee & See; Parasuraman & Riley.) Aim for
  *correspondence* between trust and real capability. Two failure modes: over-trust →
  misuse, under-trust → disuse. Notably there's an **inverted-U**: moderate
  "recommend/approve" autonomy earns better reliance than fully closed-loop autonomy.
- **Autonomy is a dial tied to risk, not a switch.** *Observe & Suggest → Plan & Propose
  → Act with Confirmation → Act Autonomously*, gated by a risk classifier (auto-approve
  low, confirm medium, full review for irreversible). This is the convergent pattern
  across LangGraph (`interrupt_on`), Claude Code (tiered permissions), and ChatGPT Agent.
- **Approval fatigue silently destroys oversight.** Gating *everything* trains
  rubber-stamping. Reduce the *number* of prompts (sandboxing, confidence thresholds,
  auto-approve safe reads) so the remaining ones get real attention — Anthropic reports
  ~84% fewer prompts via this.
- **Lifecycle transparency: intent → live trace → rationale → reversible audit log.**
  Show the plan *before* acting ("Intent Preview"), stream provenance/cost *during*,
  explain *why* after, keep an attributable, **undoable** record (LangGraph time-travel;
  AgentOps replay).
- **Always keep an exit: pause, steer, undo, escalate.** Interruptibility + reversibility
  + a humble "ask, don't guess" escalation path make delegated autonomy safe — and are
  now a regulatory expectation (EU AI Act Art. 14, enforceable Aug 2026).

→ **Cotal.** Cotal is observe-only today (no control plane for *agent behavior* beyond
the manager's process control: start/stop/attach). Control surfaces — intent broadcast,
approval gates, pause/steer, a "needs-input" state — are the biggest forward-looking
opportunity, and they belong in **core** as message kinds (see Part 2 / R5).

### E. The space behaves like a team chat — lean into it

Cotal's primitives (channels, DMs, presence, broadcast) *are* a team-chat model, so the
mature UX of Slack/Discord/Figma and CSCW "workspace awareness" research transfer almost
directly.

- **Presence is best-effort, ephemeral, TTL'd — separate from messages.** Heartbeat keys,
  never persisted, decay to offline on a missed beat; throttle at the source to avoid
  *presence storms* when many agents transition at once. (Slack/WhatsApp model.)
- **Make `waiting` the coordination hinge.** Awareness exists to enable *collaborative
  coupling* — peers knowing the right moment to step in (Gutwin & Greenberg). A
  first-class "blocked / needs input" state is the single most valuable awareness signal
  in a peer mesh.
- **Map the three delivery modes onto a notification *hierarchy*, not equals:**
  - **unicast** (direct) ↔ DM/@mention — **loud**, always surfaced.
  - **multicast** (channel) ↔ `@channel` — **rationed, quiet by default**; making it
    "loud" should require intent (the `@channel`-restriction lesson).
  - **anycast** (any handler) ↔ a **claimable queue** — surface claim/ack state so peers
    don't double-handle or drop the task.
- **Tame channel sprawl with naming + metadata + archiving, not by limiting count.**
  "No such thing as too many channels" *if* prefixes and purposes are disciplined.
  Cotal's **dotted hierarchical channels + wildcard subtree subscription** already *are*
  the prefix-namespace + "follow this subtree" affordance — lean into it; give each
  channel an explicit purpose.
- **Agents-in-chat rules.** Unmistakable non-human identity; an agent inherits the
  invoking user's data/permission scope; **show work at the right abstraction** (a plan
  block / one-line "what I'm doing", not a raw token firehose); confirmation gates for
  write/irreversible actions; clean up ephemeral interaction noise.

→ **Cotal.** The `working` presence state should carry a short live activity string (it
already supports `activity` — use it as the "what I'm doing" line). `waiting` should be
attention-generating. Anycast needs claim/ack. The renamed `tags` field doubles as the
"what this agent does" discovery signal.

### F. Carry UX in the wire contract (the Cotal-native principle)

The strongest cross-cutting pattern in current agent tooling is a **typed event/state
stream that the UI is a thin renderer over** — AG-UI (lifecycle / text / tool-call /
**state snapshot+delta** / **interrupt** events) and A2A (seven task states including
**`input-required`**, streamed over SSE). This is *exactly* Cotal's founding principle:
**"the wire contract is the standard; libraries are thin clients."**

→ **Cotal.** UX affordances should not be client-side hacks bolted onto each surface.
Define them once as **message kinds / conventions in `@cotal/core`** — intent, progress,
needs-input, claim/ack, snapshot+delta presence — so the CLI `watch`, the TUI `console`,
the `web` dashboard, and any future GUI all render the same semantics consistently. This
is both the cleanest engineering and the most faithful to Cotal's thesis.

---

## Part 2 — Applying it to Cotal (recommendations)

Grounded in what exists today: CLI (`up`, `join`, `watch`, `console`, `web`, `spawn`),
the `cotal web` browser dashboard (presence sidebar, channel list + history, live SSE
feed), presence states `idle`/`waiting`/`working`/`offline` with an `activity` line,
delivery modes multicast/unicast/anycast, hierarchical channels, and the `history`
primitive. Recommendations are tagged **[now]** (small, fits current surfaces),
**[next]** (a focused feature), **[later]** (needs protocol work / control plane).

### Overview & situational awareness (the `web` dashboard)

- **R1 — Comprehension band: golden-signal tiles. [now]** A thin strip atop the
  dashboard: *N working · N waiting · N idle · N offline · oldest-unattended*. Turns five
  raw roster rows into one integrated read of system health (Endsley L2; SRE golden
  signals). Cheap: derive from the roster + feed already in the client.
- **R2 — A dedicated "Needs you" lane. [next]** A pinned panel that collects only
  action-required items: peers in `waiting`, errored agents, unclaimed anycast aging past
  a threshold. Ordered by age. This is the non-negotiable pattern every serious tool has
  (LangGraph `interrupt`, A2A `input-required`, Replit merge gate). Keep it under strict
  alarm discipline so a red item always means "act now."
- **R3 — Presence shows *intent*, not just liveness. [now]** Render each peer's
  `activity` string prominently (the "what I'm doing" line) and make `waiting`
  visually loud (it's the coordination hinge). Distinguish *stale heartbeat* from *truly
  offline* — a peer flipping to "absent" is usually a transient reconnect, not a
  departure, so decay through a "stale" state before "offline" rather than alarming.
- **R4 — Swimlane timeline (secondary view). [later]** One lane per peer across a time
  axis showing task spans, handoffs, and blocks — the natural way to see *who's waiting
  on whom*. Prefer this and the activity feed over a DAG/graph view: a graph assumes a
  fixed orchestrator topology, which a lateral mesh doesn't have.

### Anti-overload (notifications & density)

- **R6 — Delivery modes → notification hierarchy. [next]** Treat unicast as loud/always-
  surfaced, multicast as quiet/in-feed by default, anycast as a claimable queue. The
  dashboard badge should sum only "relevant to me" items (unicast to the observer +
  needs-you), never the multicast firehose (Teams badge model).
- **R7 — Filter / mute / focus. [next]** Per-agent, per-channel, per-tier filters and
  mute (mute without losing from the log); a focus mode that shows only a chosen subset +
  critical bypass. Cotal's wildcard channel subscriptions already give the subscription
  primitive to build on.
- **R8 — Progressive disclosure + pausable feed. [now]** Default to a chunked, collapsed
  feed (roll up repeated status flips: "14 status updates"); expand a row for the raw
  events. Let the user **pause** the stream to read without content jumping, with a
  "N new — resume" affordance. Reserve motion/sound for the "needs you" tier only.
- **R9 — Catch-up / "what did I miss". [next]** Cotal already has `history` + late-join
  replay; pair it with a per-observer read marker and (later) an AI summary of a channel
  or a time window, so a returning human triages instead of re-reading.

### Transparency & control (mostly protocol work)

- **R5 — UX as core message kinds. [later, foundational]** Per Principle F, add to
  `@cotal/core` a small typed vocabulary the whole ecosystem renders:
  - **intent / plan** — "I'm about to do X" broadcast before consequential action.
  - **progress / activity delta** — streamed step/status updates (snapshot + delta, the
    AG-UI pattern, to stay cheap on the hot path).
  - **needs-input** — a first-class state (cf. A2A `input-required`) that feeds R2.
  - **claim / ack** — for anycast, so handlers don't collide or drop work.
  Define once; every surface benefits. This is the highest-leverage item.
- **R10 — Approval gates & autonomy dial. [later]** When agents take consequential
  actions (not just chat), let the human set scoped autonomy per action class and gate
  irreversible ops behind approval — *but* keep prompts few (auto-approve safe/reversible)
  to avoid approval fatigue. Pair with pause/steer and, where feasible, undo.
- **R11 — Escalation path. [later]** Encourage "ask, don't guess": an agent hitting
  ambiguity emits `needs-input` (R5) rather than acting, which surfaces in the "needs you"
  lane (R2) — closing the loop between agent humility and human oversight.

---

## Part 3 — Cotal UX tenets

A short, memorable set distilled from the above — the test any new surface should pass:

1. **Answer the three questions at a glance:** what's happening now, what changed, what
   needs me.
2. **Overview first, detail on demand.** One calm home view; drill in without losing
   context.
3. **Quiet by default; only "needs a human now" is allowed to interrupt.** Tier every
   signal; ration the loud ones.
4. **Legible agents:** who, in what role, doing what, why, on whose behalf.
5. **`waiting` is sacred** — the coordination hinge gets first-class, visible treatment.
6. **Delivery modes are a notification hierarchy,** not equals: unicast loud, multicast
   quiet, anycast a claimable queue.
7. **Calibrate trust:** transparency + cheap control (pause / steer / undo / escalate),
   never maximal-trust-by-default.
8. **Carry UX in the wire contract** — define affordances as core message kinds so every
   client renders them the same.
9. **Presence is ephemeral and lossy** — heartbeat, decay through "stale", throttle to
   avoid storms.
10. **The human is a peer beside the swarm, not a bottleneck inside it** — design for
    observation and light steering, not constant approval.

---

## Open questions

- **Where do severity tiers come from?** Self-declared by the sending agent, derived by
  the observer, or both? (Risk of agents over-escalating their own messages.)
- **How much intent/reasoning to stream** without re-creating the firehose, and on the
  hot path vs. a side channel?
- **Anycast claim semantics** — does claim/ack belong in the protocol, or is it a
  convention layered on existing subjects?
- **Multi-human observers** — read state, focus modes, and "who's watching" when more
  than one person observes a space.
- **Confidence display** — agents rarely expose calibrated confidence; categorical
  High/Med/Low is safer than percentages, but where does the value originate?

---

## Sources

Grouped by theme; the most authoritative per area. (Full URL lists were gathered during
research and can be expanded on request.)

**Human-AI interaction guidelines**
- Amershi et al., *Guidelines for Human-AI Interaction*, CHI 2019 (the 18 guidelines) — microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction
- Google PAIR, *People + AI Guidebook* (Mental Models; Explainability + Trust; Feedback + Control; Errors + Graceful Failure) — pair.withgoogle.com
- Apple, *Human Interface Guidelines* — Machine learning & Generative AI — developer.apple.com/design/human-interface-guidelines
- IBM, *Design for AI: Explainability* & Carbon *AI label* — ibm.com/design/ai, carbondesignsystem.com/guidelines/carbon-for-ai
- Nielsen Norman Group, *State of UX in 2026*, *Service Design with AI Agents*, *Generative UI* — nngroup.com

**Cognitive load & not overloading the user**
- NN/g, *Minimize Cognitive Load* and *Progressive Disclosure* (Nielsen) — nngroup.com
- Laws of UX — Hick's Law, Miller's Law — lawsofux.com
- Apple HIG, *Managing notifications* (interruption levels); Android *notification channels*
- The Joint Commission, *Sentinel Event Alert 50: alarm safety*; AHRQ PSNet, *alarm fatigue*
- Google SRE Workbook, *Monitoring* (golden signals; alerts must be actionable) — sre.google
- Slack Engineering, *How Slack Rebuilt Notifications* — slack.engineering
- Mark / Adamczyk & Bailey — interruption cost and defer-to-breakpoint (interruptions.net)

**Situational awareness & dashboards**
- Endsley, *Toward a Theory of Situation Awareness in Dynamic Systems* (1995); *Designing for
  Situation Awareness* (2003/2011)
- Shneiderman, *The Eyes Have It* (1996) — "overview first, zoom and filter, details on demand"
- Matthews et al., *Designing Glanceable Peripheral Displays* (UC Berkeley)
- Weiser & Brown, *Calm Technology*
- Smashing Magazine, *UX Strategies for Real-Time Dashboards* (2025); Carbon *Status indicators*;
  NN/g, *Indicators, Validations, and Notifications*

**Transparency, trust & control**
- Parasuraman, Sheridan & Wickens, *Types and Levels of Human Interaction with Automation* (2000)
- Lee & See, *Trust in Automation* (2004); Parasuraman & Riley, *Use, Misuse, Disuse, Abuse* (1997)
- Smashing Magazine, *Designing for Agentic AI: UX Patterns for Control, Consent, Accountability* (2026)
- Anthropic, *Claude Code auto mode*; OpenAI, *ChatGPT agent* (watch/takeover modes)
- LangChain/LangGraph, *human-in-the-loop / interrupt / time-travel*; MIT, *2025 AI Agent Index*
- EU AI Act, Article 14 (human oversight)

**Agent tooling & agent↔UI protocols**
- AG-UI (Agent-User Interaction Protocol) — docs.ag-ui.com; A2A (Agent2Agent) task states — a2a docs
- LangGraph Studio / LangSmith; Google ADK Dev UI; OpenAI Agents SDK; AutoGen Studio; CrewAI
- Coding agents: Devin, Cursor, OpenAI Codex, Claude Code Agent View, Manus, Replit Agent
- Observability: AgentOps, Langfuse, Arize Phoenix (trace tree, session replay, time-travel)

**Real-time collaboration & CSCW**
- Gutwin & Greenberg, *A Descriptive Framework of Workspace Awareness* (collaborative coupling)
- Huang et al., *Evaluating Typing Indicators* (CHI'23); WhatsApp typing-indicator design (presence storms)
- Slack, *organising channels* & *advice for large teams*; Slack *Agent design* (agents-in-chat)
- Microsoft Teams *badge count* redesign; Figma *multiplayer* (and the awareness "dark side")
- World Economic Forum, *Rethinking UX in the age of multi-agent AI*
