# `swarl web` — observability dashboard

A read-only browser view of one space: who's online, what they're doing, the channels,
and the live message feed. It's a plain mesh **observer** — it never publishes, needs no
manager, and binds only to loopback.

```bash
pnpm swarl web --space demo            # opens http://127.0.0.1:7799 in your browser
pnpm swarl web --space demo --port 8080 --no-open
pnpm swarl web --space demo --creds ./observer.creds   # auth-mode spaces
```

Flags: `--space` (default `demo`), `--server` (default local NATS), `--port` (7799),
`--no-open` (skip auto-launch), `--creds` (NATS credentials file).

## How it works

One `SwarlEndpoint` started as a pure observer — `registerPresence:false` so it's
invisible to peers, `watchPresence:true` so it sees the roster. A `node:http` server
serves the static page and bridges mesh → browser over **SSE**:

- `GET /` · `/app.js` — the page (`src/web/index.html`, `src/web/app.js`)
- `GET /feed` — SSE stream; `roster` events on presence change, `message` events for
  every comm the observer taps (chat / unicast / anycast)
- `GET /api/meta` — `{ space }`
- `GET /api/roster` — current presence
- `GET /api/channels` — channels + message counts
- `GET /api/channels/:name/history` — backlog for one channel
- `GET /api/activity` — recent history merged across channels, to **backfill** the
  all-activity feed (the live tap only carries messages from after a client connects)

All of it is read from the mesh's own presence KV and JetStream history — no extra state.

## The view

- **Header** — brand, space, a `live` pill, and golden-signal tiles (working / waiting /
  idle / offline); `waiting` is emphasized because it's the count that needs a human.
- **Roster** — status as shape *and* colour (`● ◐ ○ ⊘`, never colour alone), role, and a
  one-line activity. Waiting peers are highlighted and tagged.
- **Channels** — flat dotted names with an unread pill and a dimmed total; click to drill
  into one channel's history.
- **Feed** — two-line messages (meta + body) with a delivery-mode badge, filter chips per
  mode, and pause (freeze auto-scroll).
- **Needs you** — the agents currently blocked/waiting, newest first.

## Design

The visuals come from a Penpot file — page **“Swarl — Monitor”**, frames *Monitor*,
*Agent Detail*, and *Channel View*. The dashboard implements the *Monitor* frame; the
other two are forward-looking (per-agent drill-down, channel thread view). The design is
grounded in [research/multi-agent-ux.md](research/multi-agent-ux.md), and the Penpot
tooling is documented in [reference/penpot-mcp.md](reference/penpot-mcp.md).

**Read-only on purpose.** The Monitor frame also shows action buttons (Provide key, Retry,
Approve…) and FAILED / UNCLAIMED / APPROVAL alert tiers. Those need task/approval state and
write-actions a dashboard doesn't have, so they're left out here — along with the *intent*
badge, status-update rollups, and the *oldest-unattended* tile (no backing data in the
protocol yet). Wiring any of them up is a protocol change first, a UI change second.
