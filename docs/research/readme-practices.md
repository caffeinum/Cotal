# README practices — what others do

Research notes feeding [docs/plans/readme.md](../plans/readme.md). Fetched and analyzed
June 2026: general best-practice sources, plus the READMEs of protocol/standard repos,
agent frameworks, and dev-infra projects with hosted funnels. Word counts are measured,
not guessed.

## TL;DR for us

- **Target ~700–1,000 words.** Incumbents go shorter (NATS ~500, LangGraph ~600,
  OpenAI Agents ~560) on brand they have and we don't; the bloated outlier (CrewAI,
  ~4,100) reads as a challenger over-explaining. We need more than a signpost, less
  than a manifesto.
- **README = elevator pitch + map, never documentation.** Every mature project
  delegates depth to docs. Structure that recurs: header → one visual → premise →
  quick start → links out.
- **The unoccupied slot: a topology diagram above the fold.** None of the 17 repos
  reviewed puts an architecture/topology diagram at the top. Tree-vs-shared-space *is*
  our pitch and it's visual — this is our highest-impact differentiator.
- **Hook formula:** one sentence = what it is + the one differentiator. Add the
  objection-killer in the same breath (OpenAI Agents: "provider-agnostic… 100+ other
  LLMs"; ours: "any topology — not an orchestration tree").
- **Specifics are the credibility currency.** "Handles X via Y" beats every adjective.
  Never "easy", "simple", "powerful", "revolutionary". State Demo-1 maturity honestly —
  say *what* is stable ("the wire contract is stable; libraries are evolving") rather
  than slapping "beta" on everything.
- **Borrow credibility from the substrate.** Temporal: "originated as a fork of Uber's
  Cadence." Supabase: Postgres's 30 years. Ours: NATS/JetStream as transport, A2A
  shapes, SLIM addressing — "we didn't invent the hard parts."
- **Hosted CTA: copy PostHog.** A "Cloud (Recommended)" subsection above "Self-host
  (Advanced)", one-line tradeoff each, concrete free-tier line. Honest boundary-setting
  ("OSS has no support guarantees") builds trust *and* feeds the funnel.
- **Team faces beat metrics when metrics are thin.** tRPC's named-faces team block is
  the model; zod's "by @colinhacks" shows one honest line works too. For two people
  pre-traction this is the highest-leverage trust element we control.
- **Badges: 3–4 max, quality over vanity.** CI passing, npm version, license, Node ≥20.
  Stale or broken badges actively erode trust. One shields.io style. Not inside `<h1>`.
- **Dark/light handled via `<picture>` + `prefers-color-scheme`** with two asset files
  (a "smart" SVG with internal media queries breaks on Safari). Only LangGraph and
  LiveKit do this properly — it reads as polish.
- **Terminal demo as code:** charmbracelet/VHS `.tape` files committed to the repo,
  rendered to GIF — deterministic, regenerable, never drifts from reality. Avoid
  embedded asciinema (no autoplay, forces a click off-site).

## General best practices (sourced)

From Art of README, banesullivan/README, awesome-readme, RDD, and hero-section research:

- **Cognitive funneling**: name → one-liner → usage → install, broad to specific, so a
  reader can bail fast. Respecting reader time is framed as a feature.
- **Above the fold**: what/who/why + value + visual + one clear next action before the
  first scroll. One primary CTA (quick start), one secondary (docs) — not three.
- For a **complex/unfamiliar value proposition** (us), earn the "aha" with problem
  framing + a visual *before* the install ask — a CTA alone doesn't convert.
- **Simple install up top** (`npm i`), build-from-source pushed out. State runtime
  requirements explicitly (Node ≥20, nats-server).
- **Show, don't tell**: a 30-second demo beats a paragraph of buzzwords; first visual
  must read in a glance with one focal point. Don't make critical info image-only
  (alt text, text fallback).
- **Tone tells**: avoid "easy/simply/obviously" (condescension); question-shaped
  headings ("Why a protocol?") outperform label headings ("Description"); a human
  voice and a "what's next" line signal the project is alive.
- **Readme-driven development** (Preston-Werner): the README doubles as the spec for
  what we're promising — write it like a contract.

## Protocol / standard repos

| Repo | Words | What it teaches |
|---|---|---|
| modelcontextprotocol (spec) | ~180 | README as signpost to docs site. Pure brand-gravity move — too sparse for us. |
| MCP typescript-sdk | ~1,800 | Sentence-one standard-positioning ("in a standardized way"); clean monorepo "Packages" table. Library voice — right for sub-packages, wrong for our root. |
| a2aproject/A2A | ~1,600 | **The template.** Problem-first "Why A2A?" → "Key Features" as `capability: concrete-mechanism` bullets → one-line About pairing governance + origin ("under the Linux Foundation, contributed by Google"). Lists only real SDKs. |
| nats-io/nats-server | ~500 | **Trust-badge cluster** (build, coverage, CII best-practices) + dedicated Security/Audit section + Adopters heading. Earns 500-word terseness through brand; structure right, length not yet ours. |
| grpc/grpc | ~800 | **Two-table ecosystem layout** (in-repo vs external implementations) — maps to our packages/extensions/implementations tiers. Underclaims standardhood (no spec link, no governance) — don't copy that. |
| opentelemetry-spec | ~1,200 | **Conformance framing**: a spec-compliance matrix turns SDKs into conformance targets — literally our thesis ("libraries are thin clients over the contract"). Multi-vendor maintainer rosters = top trust signal, but only when real; empty governance is cargo-cult. |

**Patterns:** spec repos open with a definition + who's behind it and delegate
everything procedural; first-sentence "open protocol/standard for X" is universal among
the credible ones; none shows a diagram in the README (slot open for us); the recurring
failure mode is faking maturity (hollow SDK lists, empty governance).

## Agent frameworks

| Repo | Words | What it teaches |
|---|---|---|
| langchain-ai/langgraph | ~600 | Hook fuses proof + definition ("Trusted by Klarna, Replit… — a low-level orchestration framework"). Zero runnable code — survivable only on brand. |
| crewAIInc/crewAI | ~4,100 | The only one that names competitors — and the one memorable move is **one hard, linked number** ("5.76x faster than LangGraph", linked notebook), in prose, not a matrix. Also the bloat cautionary tale: duplicate Getting Started headings, FAQ restating the hook. |
| microsoft/autogen | ~1,300 | **Three-snippet difficulty ramp** (hello world → MCP → multi-agent) lets readers self-select depth. Also: one broken sentence in the README instantly reads as rushed/AI-touched — copy must be clean. |
| livekit/agents | ~1,700 | Best above-the-fold of the set: dark/light banner + a *realistic* snippet (not toy) with commented swappable alternatives — the code teaches the mental model. Install extras advertise the ecosystem (`[openai,deepgram,…]`). Has a "Building with AI coding agents" section (MCP server + skill) — directly relevant to us. |
| mastra-ai/mastra | ~690 | Deep-linked feature bullets double as a docs map; YC badge as startup trust. Weakness: 8 badge rows and no code/visual above the fold — thin for an unknown. |
| openai/openai-agents-python | ~560 | Most concentrated: one image, a **concept-list-with-deep-links as the spine**, one runnable snippet that prints its expected output as a comment. Brand substitutes for social proof — we can't skip proof the same way. |

**Patterns:** only the challenger compares by name — and the winning form is a category
reframe + one verifiable artifact, not a feature table. We should frame Cotal as a
*protocol/category* (vs frameworks), which sidesteps "is it better than LangGraph"
entirely. Quick start: the winners reach a visible "it works" moment in ≤3 steps; our
equivalent — two peers talking in a shared space — must be visible from the README.

## Dev-infra with hosted funnels

| Repo | Words | What it teaches |
|---|---|---|
| supabase/supabase | ~2,500 | Architecture diagram where every box is a real OSS component — robustness made visible. CTA woven into sentence one works only on brand. |
| temporalio/temporal | ~600 | **Pedigree sentence** as the whole maturity story ("originated as a fork of Uber's Cadence"). Coverage + Go-Report-Card badges. Zero cloud CTA in the OSS repo (church/state split) — too austere for us. |
| trpc/trpc | ~600 prose | **The team block to copy**: tiers of avatar + name + one-line role ("the people who lead the API-design decisions"). Demo GIF whose caption lands the entire value prop in one line. Sponsor tiers degrade gracefully when sparse. |
| PostHog/posthog | ~2,000 | **The funnel to copy**: "PostHog Cloud (Recommended)" above "Self-hosting (Advanced)", concrete free tier, honest OSS limits that justify the hosted tier. "We're hiring — you've proven yourself a dedicated README reader" humanizes without headshots. |
| triggerdotdev/trigger.dev | ~1,800 | Product screenshot of the **observability/trace view** near the top — our equivalent: the live roster/space view. Soft-CTA variant ("the quickest way is to create an account…"). |
| colinhacks/zod | ~400 (pointer) | "Zod 4 is stable" — one confident declarative for maturity. **Ecosystem section as social proof** ("works with tRPC, React Hook Form…") — proof that doesn't require users yet. Sponsor scaffold with empty tiers reads as ambition, not failure. |

**Patterns:** faces beat metrics when metrics are thin; quality badges (coverage, CI)
over vanity ones; candor about OSS limits is simultaneously a trust move and the
justification for hosted; a sponsors section can ship sparse from day one if framed as
tiers/an invitation.

## Mapped to our planned sections

- **Header** — centered `<div>`, logo via `<picture>` dark/light (two files), tagline,
  ≤4 badges below the `<h1>`.
- **What is Cotal** — hook = definition + differentiator + objection-killer in one or
  two sentences; problem-first like A2A's "Why A2A?".
- **Visual** — the open slot: topology diagram (tree vs shared space) and/or a VHS
  terminal GIF of peers coordinating. `.tape` committed, GIF rendered.
- **Why a protocol** — category reframe; respectful one-paragraph A2A/MCP positioning
  ("we reuse A2A's shapes"); no feature matrix.
- **Quick start** — ≤3 steps to *seeing* two peers in one space; expected output shown.
- **What we add on top of NATS** — `capability: mechanism` bullets (A2A's Key Features
  shape); doubles as the security story; substrate-pedigree sentence here.
- **Ecosystem** — gRPC-style table of what exists (core / connectors / CLI+manager) —
  only real things, no padding.
- **Hosted/onboarding** — PostHog's Recommended/Advanced pattern when the funnel
  exists; Trigger.dev's soft sentence until then.
- **Sponsors/partners** — zod-style scaffold + invitation; fine to ship sparse.
- **Team** — tRPC-style faces + name + one-line role + email.
- **Maturity** — one declarative: what's stable (the wire contract) vs what's evolving.

## Key sources

- https://github.com/hackergrrl/art-of-readme · https://github.com/banesullivan/README
- https://github.com/matiassingers/awesome-readme
- https://tom.preston-werner.com/2010/08/23/readme-driven-development
- https://github.blog/developer-skills/github/how-to-make-your-images-in-markdown-on-github-adjust-for-dark-mode-and-light-mode
- https://github.com/charmbracelet/vhs (terminal demos as code)
- https://daily.dev/blog/readme-badges-github-best-practices · https://news.ycombinator.com/item?id=21462689
- READMEs fetched June 2026: modelcontextprotocol/{modelcontextprotocol,typescript-sdk},
  a2aproject/A2A, nats-io/nats-server, grpc/grpc, open-telemetry/opentelemetry-specification,
  langchain-ai/langgraph, crewAIInc/crewAI, microsoft/autogen, livekit/agents,
  mastra-ai/mastra, openai/openai-agents-python, supabase/supabase, temporalio/temporal,
  trpc/trpc, PostHog/posthog, triggerdotdev/trigger.dev, colinhacks/zod
