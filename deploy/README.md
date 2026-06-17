# Containerized agent teams

Run a team of agents in an isolated container that connects **out** to an existing
Cotal broker. The agents get no host file access; only NATS traffic crosses the wall.

One image, two shapes — picked by the container's command:

| command | shape |
|---------|-------|
| `supervise --space <s> --roster /workspace/roster.yaml` | a manager + every agent in the roster |
| `spawn <name>` | one foreground agent (loads `.cotal/agents/<name>.md`) |

Flexibility lives in env + command, never the image: one agent or twenty, claude or
opencode, is config.

## Prerequisites

- A reachable Cotal broker (run `cotal up` somewhere the container can dial). Streams are
  created there once; the container only connects.
- A **signer file** for the space (see [Broker auth](#broker-auth-the-signer) below).
- An **account per connector type** you'll run (see [Agent accounts](#agent-accounts-model-auth)).

## 1. Build the image

```bash
docker build -f deploy/docker/Dockerfile -t cotal-runner .
```

## 2. Emit the signer (on the host beside your broker)

```bash
cotal signer            # writes ./signer.json from this space's .cotal/auth/auth.json
```

`signer.json` holds only the account signing material (`space` + `account.pub` +
`account.signingSeed`) — **not** the operator root-of-trust. The manager mints each
agent's creds from it inside the container.

## 3. Lay out a team and run

Next to `docker/compose.yaml`:

```
signer.json                 # step 2
team-a/roster.yaml          # who boots (copy docker/roster.example.yaml)
team-a/agents/*.md          # the personas the roster references
```

```bash
COTAL_SERVERS=tls://broker.host:4222 \
CLAUDE_CODE_OAUTH_TOKEN=… OPENCODE_GO_API_KEY=… \
  docker compose -f deploy/docker/compose.yaml up team-a
```

Reshape the team by editing `roster.yaml` + the agent files — never the image.

## Roster: agents, personas, count

The number of agents is the number of roster entries; mix connector types freely.

```yaml
# roster.yaml — one entry per agent, maps 1:1 to `cotal start`
agents:
  - { name: planner, agent: claude,   role: planner }
  - { name: builder, agent: opencode, role: builder }
```

- `agent` — the connector (`claude` / `opencode`), required, no default.
- `role`/`config` — optional.
- **Persona + model** come from `.cotal/agents/<name>.md` (mounted read-only): the Markdown
  body is the system prompt, `model:` the model override, `channels:` the subscriptions.

So "how many agents, which type, what persona" is entirely the roster + agent files.

## Container layout

`/workspace` is the working directory; the code reads/writes exactly here:

| path | mode | holds |
|------|------|-------|
| `/workspace/.cotal/auth/auth.json` | ro mount | the stripped signer (step 2) |
| `/workspace/.cotal/agents/*.md` | ro mount | personas |
| `/workspace/roster.yaml` | ro mount | the roster (supervise mode) |
| `/workspace/.cotal/auth/creds/` | tmpfs | minted per-agent creds (RAM only) |

## Broker auth (the signer)

This is how agents authenticate to the **NATS mesh** (not the model provider).

- **Now:** mount the stripped `signer.json`. The worst a leaked signer allows is minting
  users **within that one account**, which the NATS account boundary already contains. The
  operator key never enters a container.
- **Later (hardening):** a host-side provision step mints each agent's creds outside the
  container, so containers carry only their own `.creds` and no signing key at all.

## Agent accounts (model auth)

How each agent authenticates to its **LLM provider** — set from outside the container as env
on the service, no need to exec in. The supervisor passes its env to every agent it spawns,
and each CLI reads only the vars it understands, so a mixed team sets one var per type:

| connector | env (pick one) | account |
|-----------|----------------|---------|
| `claude`  | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on the host, ~1yr) | Claude Pro/Max, no API cost |
| `claude`  | `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | API credits / a gateway |
| `opencode`| `OPENCODE_GO_API_KEY` (or another provider's env key, e.g. `OPENAI_API_KEY`) | that provider |

Caveats:
- **opencode needs an env-key provider headless.** OAuth-only providers (stored in
  `auth.json`) won't work in-container: the connector isolates each agent's `XDG_DATA_HOME`,
  which is where opencode keeps `auth.json`, so a mounted one is hidden.
- **The container is the trust boundary.** Every agent in a team-container shares its env, so
  secrets aren't isolated *between* agents in the same container. For hard per-agent isolation,
  run one agent per container (the `solo` service) — same image, different command.

## Isolation

Phase 1 is a non-root user (uid 10001), `cap_drop: ALL`, and no host mounts beyond the
read-only ones above — the container's own writable fs is ephemeral. **Egress = the broker
+ each agent's model API** (api.anthropic.com, a gateway, or opencode's provider).

Stronger isolation (a fully `read_only` rootfs, or gVisor / Kata via `--runtime`) is a
later swap with no app change — see `.internal/plans/containerized-deployment.md`.
