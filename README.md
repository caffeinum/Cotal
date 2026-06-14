<div align="center">

<!-- TODO(asset): light-mode banner variant via <picture> once one exists -->
![Cotal: connect them all](assets/header.gif)

**The open standard for agent coordination.**

One protocol, any topology: peer-to-peer, supervised, hierarchical, hybrid.

<!-- TODO(asset): CI badge: point at the public typecheck+smoke workflow once it's live -->
[![CI](https://img.shields.io/badge/CI-pending-lightgrey)](https://github.com/Cotal-AI/Cotal/actions)
[![npm](https://img.shields.io/npm/v/@cotal-ai/core?label=%40cotal-ai%2Fcore)](https://www.npmjs.com/package/@cotal-ai/core)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)

</div>

<!-- TODO(asset): hero animation slot. Current favorite: an orchestration tree (controller, sub-agents reporting up) morphing into a shared space where the same agents talk laterally. ~5-15s seamless loop, one focal point. assets/hero.gif -->

## Overview

**What it is**<br>
Cotal is a communication and coordination layer for AI agents: a shared space where they
work together as peers, hand off tasks, and see what everyone's doing.

**Why it's different**<br>
Most agent frameworks make you pick a topology up front, usually an orchestration tree
where sub-agents report up and never talk to each other. Cotal makes topology
configuration, not architecture: one protocol runs a squad of peers, an orchestrator with
workers, or any mix.

**How it's built**<br>
A thin wire contract over [NATS + JetStream](https://nats.io): the contract *is* the
standard, and libraries are thin clients over it. Reference implementation in TypeScript.

## How it works

Agents in a space address each other three ways.

<p align="center">
<img src="assets/multicast.webp" width="32%" alt="Multicast: alice posts to the #general channel and every subscriber receives it">
<img src="assets/unicast.webp" width="32%" alt="Unicast: alice messages bob directly; the message waits in his durable inbox while he is busy and is delivered when he frees up">
<img src="assets/anycast.webp" width="32%" alt="Anycast: a message addressed to the reviewer role; exactly one free reviewer instance claims it">
</p>

**Multicast**: a message on a named channel (`#general`, `#review`) reaches everyone
subscribed. This is how a group stays in sync.

**Unicast**: addressed to one instance and delivered durably. A message to a busy or
offline agent waits until it is read; nothing is lost.

**Anycast**: addressed to a *role* ("whoever is a reviewer"); exactly one available
instance picks the work up. Delegation and load-balancing without naming a worker.

Underneath all three is **presence**: every agent publishes a live state (`idle` /
`working` / `offline`) and its [A2A](https://a2a-protocol.org) `AgentCard`, so anyone
can read the roster and see who is doing what. Lateral coordination without a central
scheduler.

## Why a protocol?

Cotal complements the two protocols already in the agent stack; it doesn't replace
them.

- **[MCP](https://modelcontextprotocol.io)** connects an agent to its tools.
- **[A2A](https://a2a-protocol.org)** connects two agents in a pairwise
  request/response.
- **Cotal** connects *many* agents coordinating live in a shared space: presence,
  channels, durable delivery, and the three addressing modes as one model.

Cotal reuses A2A's data shapes to stay interoperable: identity is an A2A `AgentCard`
(its `role` is the service anycast resolves to), and wire messages reuse A2A
`Message`/`Part`, without A2A's HTTP/JSON-RPC transport or request/response model.
Underneath, NATS + JetStream has run in production for years. We didn't invent the hard
parts.

## Quick start

```bash
npm install -g cotal-ai   # or just `npx cotal-ai`
cotal
```

One command, guided setup: it checks prerequisites, starts a local mesh, lets you pick
connectors, and drops you into a Claude session with two expert agents helping in the
background. The mesh is **open** by default (no auth, loopback-only); add `--auth` to
JWT-secure it when you share it. Full flow, CI usage (`--yes`), and re-running setup:
[docs/getting-started.md](docs/getting-started.md).

Or do it by hand: two peers in one shared space, in three steps.

> [!NOTE]
> Node ≥20 required. `cotal up` starts a local NATS (JetStream) or reuses one
> already listening on `:4222`.

```bash
# 1. start a local mesh (NATS + JetStream, open dev mode)
npx cotal-ai up --open

# 2. join as alice (second terminal)
npx cotal-ai join --space main --name alice --role coder

# 3. join as bob (third terminal) and watch presence light up in both
npx cotal-ai join --space main --name bob --role reviewer
```

Bob's terminal greets him with who's already there:

<!-- TODO(asset): VHS terminal GIF. assets/quickstart.tape committed, rendered to assets/quickstart.gif; replace this block with the rendered recording so it can't drift from the real CLI. -->

```
Joined main as bob/reviewer on #general.
Present: alice ○ idle
```

Alice's terminal prints `→ bob/reviewer joined ○ idle` as he arrives. Type a line in
either terminal and it lands in the other's `#general`. That is the whole primitive.

`npx cotal-ai web --space main` opens the space in a browser, with the roster, channels,
and live feed:

<p align="center"><img src="assets/dashboard.png" width="860" alt="The Cotal web dashboard: live roster on the left, the all-activity feed in the middle, attention queue on the right"></p>

Full walkthrough (manager-spawned peers, a real Claude Code agent on the mesh):
[`examples/01-lateral-coordination`](examples/01-lateral-coordination).

## What Cotal adds on top of NATS

NATS is the transport; Cotal is the contract on top: durable per-reader delivery
(busy/offline agents resume, late joiners replay), sender authenticity (the sender rides
the subject, policed by JWT, so impersonation fails closed), per-agent ACLs, presence,
and the three addressing modes as one model. The mechanics and the full security model
are in [docs/architecture.md](docs/architecture.md).

## Ecosystem: what runs today

| Package | What it is |
|---|---|
| [`@cotal-ai/core`](packages/core) | Endpoint, subjects, message types, the NATS client layer, and the `Connector`/`Command` contracts. |
| [`@cotal-ai/cli`](implementations/cli) | Mesh CLI: `up`, `join`, `watch`, `console`, `web`, `spawn`, `mint`, `channels`, `history`. |
| [`@cotal-ai/manager`](implementations/manager) | Agent supervisor: spawns and manages nodes via a pluggable runtime (pty / tmux / cmux), with `start`/`stop`/`ps`/`attach`. |
| [`@cotal-ai/connector-core`](extensions/connector-core) | Shared MCP-bridge runtime: the mesh agent and the `cotal_*` tools the adapters are thin clients over. |
| [`@cotal-ai/connector-claude-code`](extensions/connector-claude-code) | [Claude Code](https://claude.com/product/claude-code) adapter: installed plugin + lifecycle hooks. |
| [`@cotal-ai/connector-codex`](extensions/connector-codex) | [Codex](https://openai.com/codex/) adapter: pull-only MCP server injected via `codex -c`. |
| [`@cotal-ai/connector-opencode`](extensions/connector-opencode) | [OpenCode](https://opencode.ai) adapter: native in-process plugin injected via config. |

All connectors expose the same `cotal_*` tools. Claude Code and OpenCode push (a peer
message wakes an idle agent instantly); Codex pulls today, acting on its next turn.

## Example: one change across three repos

In [`examples/02-cmux-handoff`](examples/02-cmux-handoff), real Claude Code agents ship
one feature across three repos. An orchestrator fans tasks out by direct message, but
when the web agent needs the exact `/tasks` contract it asks the API agent directly, and
the orchestrator isn't in that exchange. Supervision and lateral handoff in the same
space: the topology lives in the example's config, never in Cotal itself.

More scenarios in [`examples/`](examples/).

## Documentation

- [docs/OVERVIEW.md](docs/OVERVIEW.md): what Cotal does and the core primitives.
- [docs/architecture.md](docs/architecture.md): how it's built (subjects, streams,
  auth, and the wire contract).

## FAQ

<details>
<summary><strong>Is Cotal TypeScript-only?</strong></summary>

The protocol isn't. Cotal is a thin contract over NATS (subjects, schemas, and required
client behaviors like presence and sender authenticity). TypeScript is the only
implementation today, but any language with a NATS client can implement the contract in
[`docs/`](docs/); official clients in other languages are planned.

</details>

<details>
<summary><strong>Why NATS underneath, and does it run distributed?</strong></summary>

JetStream streams give durable delivery to busy or offline agents, per-reader
bookmarks, and late-join history without Cotal reimplementing any of it. And yes: NATS
clustering takes the same subjects, streams, and accounts from one machine to a
distributed cluster unchanged.

</details>

## Sponsors & partners

<table>
<tr>
<td align="center" width="50%">
<a href="https://www.immersivecommons.com"><picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/partners/immersive-commons.svg">
<img src="assets/partners/immersive-commons-light.svg" height="36" alt="Immersive Commons">
</picture></a>
<br>Building Web-A, the web for agents. We're part of it and share the vision.
</td>
<td align="center" width="50%">
<a href="https://frontiertower.io"><picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/partners/frontier-tower.svg">
<img src="assets/partners/frontier-tower-light.svg" height="36" alt="Frontier Tower">
</picture></a>
<br>San Francisco's hub for frontier technologies.
</td>
</tr>
</table>

We're looking for more design partners building multi-agent systems.
[Reach out](#team).

Contributions are welcome: implement the contract in your language, build a connector,
or open an issue.

## Team

<!-- TODO(asset): team photos (assets/team/*.jpg or GitHub avatars) -->

<table>
<tr><td><!-- TODO(asset): photo --></td><td><strong>David Farah</strong>, <!-- TODO: one-line role --><br><!-- TODO: email --><br><a href="https://x.com/intent/user?screen_name=DavidFarahlb"><img src="https://img.shields.io/twitter/follow/David?style=social" alt="Follow @DavidFarahlb on X"></a></td></tr>
<tr><td><!-- TODO(asset): photo --></td><td><strong>Sven Jonscher</strong>, <!-- TODO: one-line role --><br><!-- TODO: email --><br><a href="https://x.com/intent/user?screen_name=svensonj00"><img src="https://img.shields.io/twitter/follow/Sven?style=social" alt="Follow @svensonj00 on X"></a></td></tr>
</table>

Building something on Cotal, or want to? Email us. We read everything.

## License

[Apache-2.0](LICENSE) for everything in this repo: the wire protocol, core, every
extension, and the CLI. See [LICENSING.md](LICENSING.md) for the trademark note and the
hosted-server plan.

---

<p align="center">Made with ❤️ by Cotal, in Switzerland and San Francisco.</p>
