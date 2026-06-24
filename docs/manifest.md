# Mesh manifest

> Describe a whole team — its channels, its agents, and who may read and post where — in one
> file, then launch or tear it down with a single command. The manifest is a convenience over
> the CLI; it adds no wire concepts. Today it is **single-space** (one `space:` per file).

## What it is

A manifest (`cotal.yaml`, `kind: Mesh`) is the declarative form of the things you would
otherwise do by hand: start a broker, seed some channels, spawn agents, and mint each agent
creds scoped to the channels it may use. You write the topology once; `cotal` resolves it into
per-agent access and boots it.

It is **channel-centric**: you list the channels, and under each one name the agents that may
read and post. The CLI *inverts* that into one ACL set per agent
([`resolve.ts`](../implementations/cli/src/lib/manifest/resolve.ts)) — so the file reads the way
you think about a team ("who's in #review?"), while each agent still gets least-privilege creds.

## A first manifest

```yaml
apiVersion: cotal/v1
kind: Mesh
space: research-team
broker: { host: 127.0.0.1, auth: true }   # JWT auth is the default; omit broker for the defaults
agent: claude                             # default harness for agents that don't set their own

agents:                                   # name → persona; three forms (see Fields)
  planner: ./agents/planner.md            # 1) a persona file, as-is
  builder:                                # 2) a persona file + overrides for this run
    persona: ./agents/builder.md
    model: sonnet
  lead:                                   # 3) fully inline — no file
    model: opus
    role: lead
    capabilities: [spawn]                 # may spawn helpers
    instructions: Coordinate the team.

channels:
  general:
    description: Open coordination.
    subscribe:    [planner, builder, lead]   # auto-listening at boot (and may read)
    allowPublish: [planner, builder, lead]   # post ACL — default-deny, so list it explicitly
  review:
    description: Design critique.
    subscribe:      [planner, lead]
    allowSubscribe: [planner, builder, lead]  # builder MAY read #review, but isn't auto-subscribed
    allowPublish:   [planner, lead]
  decisions:
    description: The durable record.
    subscribe:    [lead]
    allowPublish: []                          # nobody posts (e.g. a human writes here)
```

Validate and **see the access graph** before touching a broker:

```bash
cotal topology view -f cotal.yaml
```

## The four commands

| Command | What it does | Owns |
|---|---|---|
| `cotal topology view -f <file>` | Validate the file and render its access graph (per-channel and per-agent read/post, inherited scopes, warnings). Read-only — needs no broker, mutates nothing. | — |
| `cotal up -f <file>` | Bring up a **fresh** mesh: broker + seeded channels + booted agents. Refuses if a broker is already reachable at that address (use `spawn -f`). | the whole space |
| `cotal spawn -f <file>` | Deploy a manifest **additively** onto a mesh that is already running. | only what it created |
| `cotal down -f <file>` | Tear down. After `up -f`, `cotal down` stops the whole mesh; after `spawn -f`, `down -f` (or `--run <id>`) removes **only** that run's agents and channels. | — |

`up -f` and `spawn -f` accept `--dry-run` (preview the plan, change nothing). `up -f` also takes
`--server` / `--host` / `--space` / `--runtime` / `--open` to override the file for one run.

## Fields

### Top level

| Key | Required | Meaning |
|---|---|---|
| `apiVersion` | yes | Must be `cotal/v1`. |
| `kind` | yes | Must be `Mesh`. |
| `space` | yes | The space name (one per file). `spaces:` is not supported in v1. |
| `broker` | no | `host` (bind address, no scheme), `servers` (comma-separated URLs, **no embedded creds**), `auth` (bool — JWT auth, default `true`; `false` is an open dev mesh). |
| `runtime` | no | How the manager runs each agent: `pty` (default) · `tmux` · `cmux`. |
| `agent` | no | Default harness (`claude` / `opencode` / `hermes` / …) for agents that don't set their own. There is **no silent default** — an agent needs this or its own `agent:`. |
| `personaPermissions` | no | `reject` (default) — the manifest is the whole truth. `include` — a persona's own channel grants are inherited for channels the manifest doesn't declare. |
| `defaults` | no | Channel defaults applied unless a channel overrides: `replay`, `replayWindow`, `deliveryClass` (`live` / `durable`). |
| `agents` | no | name → persona (a channels-first manifest can seed rooms now and add agents later). |
| `channels` | yes | name → channel (below). |

Unknown keys are rejected (no silent ignore), and every error is reported with its file and line.

### `agents:` — three forms

```yaml
agents:
  planner: ./agents/planner.md          # 1) bare path: reuse a persona file
  builder:                              # 2) file + overrides (manifest wins)
    persona: ./agents/builder.md
    model: sonnet
    role: implementer
    instructions: Prefer the smallest change that works.
  scout:                                # 3) inline (no file): needs at least model or instructions
    agent: opencode                     #    per-agent harness override
    model: anthropic/claude-sonnet-4-6  #    opencode uses provider/model form
    instructions: Research the web; report 3 bullets.
```

Per-agent keys: `persona`, `agent` (harness override), `model`, `role`, `description`,
`instructions`, `capabilities` (e.g. `[spawn]`), `personaPermissions` (override the top-level
policy). Model strings are passed to the harness as-is — for Claude use the short form (`opus`,
`sonnet`) or the full id; for OpenCode use `provider/model`.

### `channels:` — the three access verbs

A channel carries its registry card (`description`, `instructions`, `replay`, …) plus three
lists of agent names, the same verbs Cotal uses everywhere:

| Verb | ACL | Meaning |
|---|---|---|
| `subscribe` | — | Auto-listen at boot. A subscriber is implicitly allowed to read. |
| `allowSubscribe` | **read** | May read the channel. Omitted ⇒ defaults to `subscribe`. Must be a superset of `subscribe`. |
| `allowPublish` | **post** | May post. **Default-deny** — an empty or omitted list means nobody posts. |

Every name under a channel must be declared in `agents:`. Channel names must be concrete
(no wildcards in v1).

## How access is resolved

You declare membership per channel; `cotal` inverts it into each agent's minted creds:

- **Read** comes from `allowSubscribe` (or `subscribe` when `allowSubscribe` is omitted).
- **Post** comes from `allowPublish`, and is default-deny — if you don't list an agent, it
  cannot post, even to a channel it reads.
- `subscribe` only sets what an agent *auto-listens to* at boot; it never widens read beyond
  `allowSubscribe`.

With `personaPermissions: reject` (the default) the manifest is the complete picture — a persona
file's own channel grants are ignored, so the file you read is exactly what each agent can do.
Set `include` (top level or per agent) to additionally inherit a persona's own grants for
channels the manifest doesn't mention. `cotal topology view -f` prints the resolved graph,
including inherited scopes, so you can check it before launch.

## Ownership and teardown

`cotal` only ever tears down what it owns; foreign actors on a shared mesh are never touched.

- **`up -f` owns the whole space.** It created the broker and seeded everything, so `cotal down`
  stops all of it.
- **`spawn -f` owns only what it created.** It writes a creation-only ledger
  (`.cotal/manifests/<runId>.json`) recording exactly the channels and agents it added, and
  `down -f` removes only those.

`spawn -f` classifies each declared item against the live mesh:

| Item | Classification | Behavior |
|---|---|---|
| Channel, brand-new | created + owned | Seeded and recorded in the ledger. |
| Channel, already present | `exists-unmanaged` | Left untouched — its card is not mutated; the desired card is shown against the live one. |
| Agent, not yet created | will-create | Booted and recorded. |
| Agent, already created, unchanged | already-owned | No-op. |
| Agent, already created, policy changed | `stale` | Exits non-zero unless `--allow-stale <names>` (then it restarts). |

If an **unmanaged** actor already has read access to a channel you declare, `spawn -f` prints a
SECURITY warning — an isolation conflict on a shared mesh. This is an explicit *lower bound*
(presence plus the broker membership feed), not a guarantee that no other access exists.

`down -f` is deliberately conservative — it treats the ledger as untrusted and validates the
whole of it before deleting anything:

- An owned agent is stopped only when the live agent's recorded **name *and* id** match (a
  same-name, different-id agent is foreign and left alone).
- Credential files are derived from the auth root and deleted without following symlinks.
- An owned channel is removed only when no other members remain.
- If the broker is unreachable or anything is uncertain, nothing remote is removed and the
  ledger is **retained** so a later `down -f --run <id>` finishes the job.
- An edited manifest no longer matches its ledger; `down -f` then fails with a `--run` hint
  rather than guessing. `down -f` is local-only — run it from the same checkout that created the
  run.

## Operating a manifest mesh

The mesh-level commands (`send`, `channels`, `console`, `web`, plus `up -f` / `spawn -f` /
`down -f` themselves) resolve the broker from the mesh registry, so `--space <name>` is enough.

**Known limitation:** the manager control commands — `cotal ps` / `start` / `stop` / `attach` —
do **not** yet registry-resolve the broker, and default to `nats://127.0.0.1:4222`. For a
manifest mesh on a non-default port, pass an explicit `--server`:

```bash
cotal ps --space research-team --server nats://127.0.0.1:14999
```

A follow-up will route these through the same resolution as the rest of the CLI.

## Today / not yet

| | Status |
|---|---|
| Single space per file (`space:` scalar) | ✅ today |
| `up -f` / `spawn -f` / `down -f` / `topology view -f` | ✅ today |
| `--server` resolution for `ps`/`start`/`stop`/`attach` | follow-up |
| Multiple spaces per manifest (`spaces:`) | not in v1 |
