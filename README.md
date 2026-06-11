<div align="center">

<!-- TODO(asset): light-mode banner variant via <picture> once one exists -->
![Cotal](assets/header.gif)

**The open standard for agent coordination.**

One protocol, any topology: peer-to-peer, supervised, hierarchical, hybrid.

<!-- TODO(asset): CI badge: point at the public typecheck+smoke workflow once it's live -->
[![CI](https://img.shields.io/badge/CI-pending-lightgrey)](https://github.com/Cotal-AI/Cotal/actions)
[![npm](https://img.shields.io/npm/v/@cotal-ai/core?label=%40cotal-ai%2Fcore)](https://www.npmjs.com/package/@cotal-ai/core)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)

</div>

<!-- TODO(asset): hero animation slot. Current favorite: an orchestration tree (controller, sub-agents reporting up) morphing into a shared space where the same agents talk laterally. ~5-15s seamless loop, one focal point. assets/hero.gif -->

## What is Cotal

Cotal is a wire interface for software (AI agents especially) to coordinate in real
time as **lateral peers in a shared pub/sub space**, not as nodes under a controller.
The contract (subjects, message schemas, presence conventions) *is* the standard;
libraries are thin clients over it.

Pick an agent framework today and you inherit its topology. Most hand you an
orchestration tree: one controller, sub-agents that report up and never talk to each
other. The few that don't give you raw point-to-point messaging with no shared space:
no roster, no history, no notion of "who else is here."

Cotal separates coordination from topology. Agents join a space, hold presence, and
address each other directly; who delegates to whom is configuration, not architecture.
The same protocol runs a squad of peers, an orchestrator with workers, a hierarchy, or
any mix. Transport is [NATS + JetStream](https://nats.io); the reference implementation
is TypeScript.

## How it works

Agents in a space address each other three ways, borrowed from
[SLIM](https://github.com/agntcy/slim)'s addressing model.

**Multicast: broadcast to a channel.** A message on a named channel (`#general`,
`#review`) reaches everyone subscribed to it. This is how a group stays in sync.

<!-- TODO(asset): multicast animation. One agent posts to a channel, all subscribers light up. assets/multicast.gif -->

**Unicast: message one peer.** Addressed to a specific instance and delivered durably:
a message to a busy or offline agent waits on the stream until it is read; nothing is
lost.

<!-- TODO(asset): unicast animation. One agent sends directly to another; the message waits in the recipient's inbox until read. assets/unicast.gif -->

**Anycast: reach any one of a role.** Address a *service* ("whoever is a reviewer")
and exactly one available instance picks the work up. Delegation and load-balancing
without naming a worker.

<!-- TODO(asset): anycast animation. A request to "reviewer" routed to one of several role instances. assets/anycast.gif -->

Underneath all three: **presence**. Every agent publishes a live state (`idle` /
`waiting` / `working` / `offline`) and its [A2A](https://a2a-protocol.org)
`AgentCard`. Anyone in the space can read the roster and see who is doing what, which
is what makes lateral coordination possible without a central scheduler.

## Why a protocol?

Cotal complements the two protocols already in the agent stack; it doesn't replace
them.

- **[MCP](https://modelcontextprotocol.io)** connects an agent to its tools.
- **[A2A](https://a2a-protocol.org)** connects two agents in a pairwise
  request/response.
- **Cotal** connects *many* agents coordinating live in a shared space: presence,
  channels, durable delivery, and the three addressing modes as one model.

Cotal reuses A2A's data shapes to stay interoperable: identity is an A2A `AgentCard`
(its `role` is the addressable service that anycast resolves to), and wire messages
reuse A2A `Message`/`Part`. It does not adopt A2A's HTTP/JSON-RPC transport, `Task`
RPCs, or request/response server model. Only the shapes carry over. Underneath, NATS +
JetStream has run in production for years. We didn't invent the hard parts.

## Quick start

Two peers in one shared space, in three steps.

> **Requirements:** Node ≥20 and `nats-server` with JetStream (v2.11+). On macOS:
> `brew install nats-server`. `cotal up` starts a local one, or reuses one already
> listening on `:4222`.

<!-- TODO(bin): publish the `cotal` bin before this section goes live; no package ships a `bin` field yet. Until then the honest invocation is `pnpm cotal <cmd>` from a clone. -->

```bash
# 1. start a local mesh (NATS + JetStream, open dev mode)
npx cotal up --open

# 2. join as alice (second terminal)
npx cotal join --space demo --name alice --role coder

# 3. join as bob (third terminal) and watch presence light up in both
npx cotal join --space demo --name bob --role reviewer
```

Bob's terminal greets him with who's already there:

<!-- TODO(asset): VHS terminal GIF. assets/quickstart.tape committed, rendered to assets/quickstart.gif; replace this block with the rendered recording so it can't drift from the real CLI. -->

```
Joined demo as bob/reviewer on #general.
Present: alice ○ idle
```

Alice's terminal prints `→ bob/reviewer joined ○ idle` as he arrives. Type a line in
either terminal and it lands in the other's `#general`. That is the whole primitive.

`npx cotal web --space demo` opens the space in a browser, with the roster, channels,
and live feed:

![The Cotal web dashboard: live roster on the left, the all-activity feed in the middle, attention queue on the right](assets/dashboard.png)

For the full walkthrough (manager-spawned peers, a real Claude Code agent joining the
mesh), see [`examples/01-lateral-coordination`](examples/01-lateral-coordination).

## What Cotal adds on top of NATS

NATS is the transport; Cotal is the contract on top. Each capability maps to a concrete
mechanism you can check against the code:

- **Sender authenticity.** Every subject carries the sender's token
  (`cotal.<space>.inst.<target>.<sender>`), policed by the server against the
  authenticated JWT rather than self-asserted; mismatches are rejected on every
  receive path, fail-closed. An agent can only ever emit as itself; payload claims of
  identity are ignored.
- **Per-agent ACLs.** Decentralized JWT auth (`@nats-io/jwt`, no `nsc`) where
  account = space and user = agent. The `agent`, `observer`, and `admin` profiles are
  default-deny allow-lists (`manager` is the privileged allow-all profile, not
  user-mintable); `cotal mint <name> --profile agent` writes a creds file.
- **DM confidentiality by construction.** Two leak paths are closed: delivery is
  ACL-gated by subject, and replay is gated because a privileged provisioner
  pre-creates each agent's bind-only inbox consumer; every consumer-create form on the
  DM and task streams is denied to agents. (DMs are plaintext and ACL-gated, not
  encrypted.)
- **Durable, per-reader delivery.** Three JetStream streams per space
  (`CHAT_<space>`, `DM_<space>`, `TASK_<space>`), with a bookmark per reader. Busy and
  offline agents read from where they left off; a late joiner replays history, then
  goes live.
- **Presence and a live channel registry.** Presence is a per-space NATS KV bucket
  (key = instance, bucket TTL + heartbeat). Channels carry a registry (replay policy,
  description, instructions) watched live over KV.
- **Three delivery modes, one model.** Multicast, unicast, and anycast are one
  addressing scheme (subjects `chat.>`, `inst.>`, `svc.>`) over the same space, not
  three transports; the message class is derived from the subject that delivered it.
- **Roles as addressable services.** A role is the anycast address: "send to any
  reviewer" routes through a shared work queue, so specialization is part of the
  addressing rather than glued on top.

### Ecosystem: what runs today

| Package | What it is |
|---|---|
| [`@cotal-ai/core`](packages/core) | Endpoint, subjects, message types, the NATS client layer, and the `Connector`/`Command` contracts. |
| [`@cotal-ai/cli`](implementations/cli) | Mesh CLI: `up`, `join`, `watch`, `console`, `web`, `spawn`, `mint`, `channels`. |
| [`@cotal-ai/manager`](implementations/manager) | Agent supervisor: spawns and manages nodes via a pluggable runtime (pty / tmux / cmux), with `start`/`stop`/`ps`/`attach`. |
| [`@cotal-ai/connector-core`](extensions/connector-core) | Shared MCP-bridge runtime: the mesh agent and the `cotal_*` tools the adapters are thin clients over. |
| [`@cotal-ai/connector-claude-code`](extensions/connector-claude-code) | [Claude Code](https://claude.com/product/claude-code) adapter: installed plugin + lifecycle hooks. |
| [`@cotal-ai/connector-codex`](extensions/connector-codex) | [Codex](https://openai.com/codex/) adapter: pull-only MCP server injected via `codex -c`. |
| [`@cotal-ai/connector-opencode`](extensions/connector-opencode) | [OpenCode](https://opencode.ai) adapter: native in-process plugin injected via config. |

The connectors attach differently but expose the same `cotal_*` tools. The difference
that matters: Claude Code's hooks can wake an idle agent the instant a channel message
arrives; Codex and OpenCode pull, acting on messages on their next turn.

## Example: one change across three repos

In [`examples/02-cmux-handoff`](examples/02-cmux-handoff), real Claude Code agents ship
a single feature spanning three repositories. An orchestrator spawns the workers and
fans the tasks out by direct message. When the web agent needs the exact `/tasks`
contract, it asks the API agent directly over the mesh; the orchestrator isn't in that
exchange. Supervision and lateral handoff in the same space: the topology lives in
the example's config, never in Cotal itself.

More scenarios in [`examples/`](examples/).

## Documentation

- [docs/OVERVIEW.md](docs/OVERVIEW.md): what Cotal does and the core primitives.
- [docs/architecture.md](docs/architecture.md): how it's built (subjects, streams,
  auth, and the wire contract).

## FAQ

**Why not just A2A or MCP?**
They solve different layers. MCP connects an agent to its tools; A2A connects two
agents in a pairwise request/response. Neither gives you a live shared space with
presence, channels, durable delivery, and topology-free coordination. That's the gap
Cotal fills. Reusing A2A's `AgentCard` and `Message`/`Part` shapes keeps the two
interoperable.

**Is Cotal TypeScript-only?**
The protocol isn't. Cotal is a contract over NATS (subjects, schemas, *and* required
client behaviors like presence, ack-on-surface, and sender authenticity), and the layer
is deliberately thin. TypeScript is the only implementation today; any language with a
NATS client can implement the contract documented in [`docs/`](docs/), and official
clients in other languages are planned.

**Why NATS underneath, and does it run distributed?**
JetStream streams give durable delivery to busy or offline agents, per-reader
bookmarks, and late-join history without Cotal reimplementing any of it. And yes: NATS
clustering takes the same subjects, streams, and accounts from one machine to a
distributed cluster unchanged.

**Can an agent impersonate another?**
No. The sender rides the NATS subject, which the server polices against the agent's
JWT; a payload claiming a different sender is rejected. DMs are confidential by
construction: a per-identity inbox served by a bind-only durable that agents can't
re-create or re-target.

## Sponsors & partners

We're looking for design partners building multi-agent systems. [Reach out](#team).

Contributions are welcome: implement the contract in your language, build a connector,
or open an issue.

<!-- TODO(asset): sponsor logos once partners are named -->

## Team

<!-- TODO(asset): team photos (assets/team/*.jpg or GitHub avatars) -->

| | |
|---|---|
| <!-- TODO(asset): photo --> | **David Farah**, <!-- TODO: one-line role --><br><!-- TODO: email --> |
| <!-- TODO(asset): photo --> | **Sven Jonscher**, <!-- TODO: one-line role --><br><!-- TODO: email --> |

Building something on Cotal, or want to? Email us. We read everything.

## License

[Apache-2.0](LICENSE) for everything in this repo: the wire protocol, core, every
extension, and the CLI. See [LICENSING.md](LICENSING.md) for the trademark note and the
hosted-server plan.
