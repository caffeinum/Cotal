# Spaces

> The space concept, why it's distinct from a channel, and how spaces connect.
> §1–3 describe what Cotal does **today**; §4–6 are **design direction**, not yet built.

## 1. What a space is

A **space** is one collaboration — and it's the *only* thing in Cotal that carries
membership, identity, and isolation. Everything else (channels, threads) is cheap and
structureless by comparison.

Concretely, today:

- Every subject is scoped to it: `cotal.<space>.{chat,inst,svc,ctl}.…`
  ([`subjects.ts`](../packages/core/src/subjects.ts)).
- Each space has its own streams (`CHAT_<space>` / `DM_<space>` / `TASK_<space>`) and its
  own presence KV bucket (`cotal_presence_<space>`).
- **In auth mode a space is one NATS account** — a real, server-enforced boundary
  ([`provision.ts`](../packages/core/src/provision.ts)). In `--open` dev mode it's one
  shared account and the boundary is just the subject prefix (soft isolation).
- An endpoint is bound to one space for its lifetime. To be in two spaces, run two
  endpoints.

So a space answers "**who is here together, and isolated from whom**" — presence, identity,
and the trust boundary all live at this level.

## 2. Space vs channel — why both

A channel is a *topic*, not a room. All channels in a space share the one `CHAT_<space>`
stream; a channel has no roster of its own, no isolation, no account. It's a routing suffix
on multicast.

They're different axes:

| | Space | Channel |
|---|---|---|
| Carries | membership, identity, isolation, presence | nothing — just a topic |
| Maps to | a NATS **account** (auth mode) | a NATS **subject** suffix |
| Scope | "who's in this collaboration" | "what subtopic" |

Collapsing space into "just channels" would drop the per-collaboration roster and the
isolation boundary — you'd be back to one global namespace with topic prefixes (exactly
`--open` mode's soft isolation). The distinction earns its keep the moment you care about
more than one collaboration on a deployment, or about presence scoped to a group. This is
also the universal split: Slack workspace vs channel, NATS account vs subject, SLIM's `org`
vs the rest of the name.

## 3. Channels inside channels? No.

Keep **one** membership boundary (the space). For everything below it, two cheaper tools
already exist:

- **Sub-topics → hierarchical channel *names*.** Channels are NATS subjects, so `team`,
  `team.backend`, `team.backend.api` already nest. Subscribe `team.>` for the subtree or
  `team.*` for one level. No new concept needed.
- **Sub-conversations → flat threads.** The envelope already carries `replyTo` and
  `contextId` ([`types.ts`](../packages/core/src/types.ts)) — a thread is a relation to a
  root message, one level deep.

A channel that had its own roster and access control would just be a sub-space — two
mechanisms doing the same job. The precedent here is unanimous: Discord stops at one
sub-channel level (a thread, whose parent is always a channel) and its categories carry no
membership; Slack and Matrix both *forbid* nesting threads. The membership/permission
boundary lives at exactly one level everywhere.

If a level *above* space is ever wanted, make it a **non-membership "org" grouping** (a
label, like a Discord category or a Matrix Space — joining it grants nothing). Usefully,
that org label is also the identity qualifier federation needs (§5) — one concept, two
payoffs.

## 4. Connecting spaces — the rule

**Never merge trust roots.** In NATS the *operator* is the trust anchor: a server trusts
exactly one operator, and two independent operators cannot federate. Since a space is an
account under an operator, "connect two spaces" splits cleanly by whether they share one:

- **Same operator** (two collaborations in one deployment) → connect them *inside* NATS
  with **account export/import**: an account exports specific subjects (a stream) or a
  request/reply endpoint (a service); the other imports them, with subject remapping and
  (for private exports) an activation token. Server-enforced, no relay process.
- **Different operators** (two parties, each running their own cluster/auth) → real
  **federation**. You don't fuse them; you bridge a **narrow surface**, with each side
  keeping its own operator. NATS's sanctioned cross-operator mechanism is the **leaf node**:
  the bridging side authenticates into the remote with a credential the remote issued, binds
  as one account there, and its permissions whitelist exactly which subjects cross.

Every federated system agrees on the shape: bridge **one channel**, not the whole tenant
(Slack Connect shares a single channel with admin approval on both sides); keep identity
**namespaced by home** (`alice@spaceB`); and at the boundary, **trust the signature, not the
pipe**.

## 5. The staged path (proposed)

- **v0 — origin-qualified identity.** Add an additive `name@space` qualifier to the
  envelope / `AgentCard` so a remote peer is unambiguous. Cheap, non-breaking, and a
  prerequisite for any bridge — it's the one thing every federated system requires.
- **v1 — application-level relay.** A bridge endpoint that holds **a separate credential
  each side issued independently** (so no trust-root merge) forwards one channel both ways
  and mirrors designated presence. Needs: a forwarded-message marker (loop prevention),
  identity rewriting with the origin qualifier, and explicit config on both ends (the
  approval handshake). Works in **open *and* auth mode** with **no NATS reconfiguration**,
  and fits Cotal's "thin client over the wire" ethos. A clean variant is a **rendezvous
  space**: both parties' delegates meet in a neutral third space rather than reaching into
  each other's — self-similar with Cotal's own primitive, and nobody holds the other's creds.
- **v2 — NATS-native, server-enforced.** Graduate to account **export/import** (same
  operator), **leaf nodes** (cross-operator), and **mirror/source** streams if durable
  cross-space history is needed ("copy, don't share"; pull-only). Heavier (activation
  tokens, JetStream domains) but no relay hop.
- **North star — encrypted group as the boundary.** Make a federated channel an
  end-to-end-encrypted group whose membership is *keys* (MLS-style), so relays carry
  ciphertext without being trusted, with DID/keypair self-issued identity. This is where the
  agent ecosystem (SLIM, AGNTCY, NANDA) is heading; cross-fabric routing/presence is still
  unsolved — room for Cotal to lead. Don't build now, but don't block it.

## 6. Status

| Area | Today | Proposed |
|---|---|---|
| Space = membership/trust/presence boundary | ✅ | |
| Hierarchical channel names + `replyTo`/`contextId` threads | ✅ | |
| `name@space` origin-qualified identity | | v0 |
| App-level channel bridge / rendezvous space | | v1 |
| Account export/import · leaf nodes · mirror/source | | v2 |
| Encrypted-group boundary + DID identity | | north star |

## Prior art

The model above is derived from how existing systems handle the same problems:

- **NATS** — [accounts & export/import](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/accounts),
  [leaf nodes](https://docs.nats.io/running-a-nats-service/configuration/leafnodes),
  [JetStream source/mirror](https://docs.nats.io/nats-concepts/jetstream/source_and_mirror),
  [JWT trust model](https://docs.nats.io/running-a-nats-service/nats_admin/security/jwt).
- **Federation** — [Matrix S2S](https://spec.matrix.org/v1.11/server-server-api/),
  [XMPP dialback](https://xmpp.org/extensions/xep-0220.html),
  [DMARC](https://datatracker.ietf.org/doc/html/rfc7489),
  [ActivityPub](https://www.w3.org/TR/activitypub/).
- **Cross-org / bridging** — [Slack shared channels](https://slack.engineering/how-slack-built-shared-channels/),
  [Mosquitto bridging](https://mosquitto.org/man/mosquitto-conf-5.html),
  [Confluent Cluster Linking](https://docs.confluent.io/platform/current/multi-dc-deployments/cluster-linking/index.html),
  [Discord threads](https://docs.discord.com/developers/topics/threads).
- **Agent-native** — [SLIM](https://www.ietf.org/archive/id/draft-mpsb-agntcy-slim-00.html),
  [A2A discovery](https://a2a-protocol.org/latest/topics/agent-discovery/),
  [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
  [libp2p gossipsub](https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md).
