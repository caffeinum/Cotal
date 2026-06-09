# Hermes connector

> Hermes = [Nous Research's **Hermes Agent**](https://hermes-agent.nousresearch.com) — the
> open-source `hermes` CLI + `hermes gateway` daemon.

The connector turns a real Hermes **gateway** into a Cotal mesh peer. Unlike Claude Code / Codex —
where the harness *is* the process and an MCP server rides inside it — Hermes runs as a long-lived
daemon that spins up a fresh `AIAgent` per inbound message. So the mesh endpoint can't live inside
a per-turn MCP server; it must outlive every turn. That one fact shapes the whole design.

> The mesh runtime — `MeshAgent`, presence, the stream-backed inbox, the hook relay — is reused
> from [`@cotal-ai/connector-core`](../extensions/connector-core); this package adds the Hermes
> specifics (a launcher/supervisor + a Python gateway plugin).

## Shape: a launcher that owns the endpoint + an in-gateway plugin

```
manager ─spawn─▶ launch.ts (the connector's command, in a PTY)
                 ├─ owns MeshAgent ........... NATS endpoint, presence, stream-backed inbox
                 ├─ control socket ........... ← Python presence hooks (relay.ts pattern)
                 ├─ bridge socket ............ ⇄ Python adapter + cotal_* tools
                 └─ spawns child ──▶ `uv run hermes gateway run`  (isolated HERMES_HOME)
                                     └─ cotal plugin: adapter + hooks + tools
```

- **`src/launch.ts`** is the connector's command. It owns the single `MeshAgent` for the gateway's
  whole life, runs connector-core's **control socket** (presence hooks) + a small **bridge socket**
  (the gateway adapter), sets up an isolated `HERMES_HOME` profile, and supervises
  `hermes gateway run` as a child (stdio inherited, so the PTY you attach to is the gateway).
- The **Python plugin** (`plugin/cotal/`, dropped into the profile's `plugins/` dir at launch)
  registers three things on the Hermes plugin context: a **gateway platform adapter**, **lifecycle
  hooks**, and the **cotal_\* tools** — all backed by the sidecar over the two sockets. No mesh code
  in Python: the TS sidecar owns the endpoint; the plugin is a thin bridge client.

This is the documented cross-language pattern: connector-core's
[`relay.ts`](../extensions/connector-core/src/relay.ts) /
[`control.ts`](../extensions/connector-core/src/control.ts) already bridge an out-of-process hook
runtime to the live endpoint over a unix socket; the hooks reuse it verbatim, and the adapter adds
one persistent socket for the push direction the one-shot control socket can't do.

## How a session joins

The connector ([`src/extension.ts`](../extensions/connector-hermes/src/extension.ts)) launches:

```
uv run --project <pkg> hermes gateway run
# env: COTAL_SPACE, COTAL_NAME, COTAL_ROLE, COTAL_SERVERS (+ COTAL_ID/COTAL_CREDS under auth),
#      HERMES_HOME=<isolated profile>, COTAL_CONTROL_SOCKET, COTAL_BRIDGE_SOCKET
```

- **Isolated profile.** `HERMES_HOME` points at a per-agent temp dir; the launcher writes its
  `config.yaml` (approvals off) and drops the cotal plugin into `plugins/cotal`. The operator's
  own `~/.hermes` is never touched — the profile dir *is* the isolation (Hermes has no in-memory
  `-c` like Codex).
- **Auto-enabled platform.** The cotal platform's only required env is `COTAL_BRIDGE_SOCKET`, which
  the launcher always sets, so the adapter comes up at gateway startup with no extra config.
- **Identity-gated.** `launch.ts` stays inert without `COTAL_NAME` (connector-core's `hasIdentity`),
  so a stray run never joins the mesh.
- **Autonomy.** `approvals.mode: off` so an unattended gateway never blocks on a command-approval
  prompt; Hermes' hardline blocklist still applies.
- **Persona.** An agent file's persona is written to the profile's `SOUL.md` at launch (the one
  place a system prompt can be set).

## Presence mapping (hooks → presence)

The Python plugin forwards Hermes lifecycle hooks to the control socket; the
[`hermesHookHandle`](../extensions/connector-hermes/src/hermes-hooks.ts) maps them to presence.
Content delivery rides the adapter, so hooks only move presence — they never inject or ack.

| Hermes hook | → state |
|---|---|
| `gateway_startup` / `on_session_start` | `idle` |
| `pre_llm_call` | `working` |
| `pre_tool_call` | `working` (records the tool as activity) |
| `approval_wait` | `waiting` (blocked on command approval) |
| `post_llm_call` / `on_session_end` | `idle` (and flush any held ambient messages) |
| `gateway_shutdown` | `offline` |

## Drive a live agent (the gateway adapter)

Inbound is the headline. The sidecar pushes a buffered mesh message over the bridge; the adapter
builds a `MessageEvent` and calls `handle_message` — which **wakes an idle session or queues +
interrupts a running one** (the gateway's own busy handling). So a peer can drive a *live* turn,
not just leave a message — and Hermes' mid-run slash control (`/stop`, `/approve`, …) is there too.
This goes beyond Claude Code's idle-only channel nudge.

- **Serial, ack-on-surface.** The sidecar pushes the oldest buffered message, waits for the
  adapter's `delivered`, then acks exactly that message before pushing the next. A crash before
  `delivered` redelivers — nothing is lost (the stream-backed inbox contract).
- **Reply routing.** A turn's reply is handed to the adapter's `send()`, which routes it back to the
  message's origin — a broadcast on the channel it came in on, or a DM to the sender. So the agent
  just answers; the reply lands back on the mesh automatically.

## Tools

The `cotal_*` tools (roster, send, dm, anycast, status, inbox, spawn) are registered as **native
Hermes plugin tools** that forward to the sidecar over the bridge — the idiomatic equivalent of the
stdio MCP server the Claude Code / Codex connectors use. A turn's *reply* is delivered
automatically, so these are for reaching *other* peers/channels and reporting status.

## Bridge protocol

Newline-delimited JSON over a unix socket ([`src/bridge.ts`](../extensions/connector-hermes/src/bridge.ts)
↔ [`plugin/cotal/bridge_client.py`](../extensions/connector-hermes/plugin/cotal/bridge_client.py)):

```
Python → sidecar   {t:"subscribe"} · {t:"delivered",id} · {t:"reply",target,text} · {t:"tool",id,op,args}
sidecar → Python   {t:"incoming",msg} · {t:"tool_result",id,ok,data?,error?}
```

## Run it

Needs `uv` and a provider key (Hermes is model-agnostic — `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or `NOUS_API_KEY`; override the model with `HERMES_MODEL`). With a mesh up
(`cotal up`) and the manager running, spawn a Hermes peer like any other agent type:

```
cotal spawn alice --type hermes --space demo      # foreground
# or via a peer: cotal_spawn(name="alice", role="builder")  with the hermes connector registered
```

## Verification status

Verified in CI-able form (no Hermes needed): `pnpm typecheck`, `pnpm smoke`, and a sidecar
self-test — the launcher's `MeshAgent` joins a live NATS, the bridge tool round-trips, and a
control-socket hook moves presence. The **gateway-side** wiring (the Python adapter/hooks/tools
running inside a real `hermes gateway`) is built against the Hermes 0.16 plugin API but needs a
Hermes install + provider key to exercise end-to-end; the `config.yaml` keys and plugin-API
signatures are best-effort for that line — validate against your version.
