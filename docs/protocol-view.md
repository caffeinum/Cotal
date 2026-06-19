# Protocol view — one model, many surfaces

> The design origin for every surface that lets a human *watch and operate* a live mesh:
> the terminal console, the web dashboard, and the plain stream. Defines the shared model
> and which features each surface renders, so they never drift apart. Supersedes the old
> `implementations/cli/src/console/SPEC.md`.

A "protocol view" is a **read-only observer** over a space — a `CotalEndpoint` with
`consume:false, registerPresence:false, watchPresence:true`, invisible to peers. Everything
below is derived from that one observer; no surface opens its own NATS connection, and none
re-implements the wire semantics. The wire is the source of truth; these are renderings of it.

## Surfaces

| surface | command | intent | stack |
|---|---|---|---|
| **console** | `cotal console` | interactive terminal — drive it, drill in | Ink / React (TTY) |
| **stream** | `cotal console --plain`, pipes | passive line log — tail it, grep it, CI | plain ANSI |
| **web** | `cotal web` | operator dashboard — see what needs you | HTTP + SSE, vanilla JS |

`console` auto-selects: a real TTY gets the Ink TUI, a pipe/`--plain` gets the stream. `watch`
is an alias of `console --plain`. The web dashboard is a **god-view** (self-mints an admin cred
so it sees DMs + anycast); the terminal console sees what its creds allow (`dmVisible`).

**Admin overview.** `cotal console` with **no `--space`** on an open mesh opens a space picker first —
every space on the server (enumerated from its `CHAT_*` streams + presence buckets via
`listSpaces()`) with agents / channels / message counts. Pick one to drop into its console; `b`
returns to the overview. `--space X` skips the picker. Under auth a server hosts a single space, so
the console just enters it directly (no overview).

**Generate traffic to test them:** `cotal demo --space demo` spins up a handful of mock agents
that loop a scripted trace hitting every message type (multicast across channels + mentions,
peer DMs, a coalesced burst, an unclaimed anycast) and every presence state — run it next to
`cotal console` / `cotal web`.

## The shared model — `MeshView` (`@cotal-ai/cli`)

One class consumes the observer and emits a normalized, render-agnostic model. No ANSI, no
React, no HTML, no color palette — pure data. It owns the endpoint lifecycle
(`start → tap → stop`) and batches every source (roster events, the tap, burst flushes, channel
polls, the rate/age heartbeat) into one snapshot per tick.

```ts
new MeshView(ep, { window?, tapSubject? })
  .on("entry",  (e: FeedEntry) => …)   // one classified+coalesced row, as it lands (stream)
  .on("change", (s: MeshSnapshot) => …) // batched snapshot (~75ms) for dashboards
  await view.start(); …; await view.stop();

interface MeshSnapshot {
  agents:    Presence[];   // card.kind === "agent", sorted working→waiting→idle→offline, then name
  endpoints: Presence[];   // everything else
  channels:  { channel: string; messages: number }[];
  feed:      FeedEntry[];  // classified + coalesced + windowed
  rates:     { msgsPerSec: number };
  status:    { connected: boolean; space: string; dmVisible: boolean; error?: string };
  signals:   MeshSignals;  // derived operator signals (below)
  nameOf:    (id: string) => string;   // unicast target id → display name
}

interface FeedEntry {           // one feed row
  id; ts; from: EndpointRef;
  delivery: "multicast" | "unicast" | "anycast";
  channel?; toService?;         // multicast / anycast target
  toNames?: string[]; count?;   // unicast: resolved targets + burst multiplicity
  text: string;                 // parts joined, no ANSI
}
```

**What the model already does** (today, split across `render.ts` + `console/mesh.ts` +
`web/app.js` — Phase A folds it into one place):

- **Classification** — `deliveryOf(subject)` → chat / unicast / anycast (the view renders `chat`
  as multicast); `null` (control, presence, trace) drops out of the feed.
- **Coalescing** — same-sender/same-text unicast bursts within 400 ms collapse to one entry
  (deterministic `id` = first message, `ts` = earliest, `count` = multiplicity).
- **Roster** — status-sorted snapshot + `byId` map for id→name; agents split from endpoints.
- **History prefill** — one-shot per-channel backlog (multicast only — `dmHistory` needs admin),
  deduped against the live tap by `id`.
- **Windowing** — feed capped (~300), rolling `msgs/s` rate.

### Derived operator signals

The web dashboard already computes these client-side (`dmPeers`, `waitingCards`, the tile
counts). They move into the model so the TUI gets them for free too.

```ts
interface MeshSignals {
  counts:  { working; waiting; idle; offline };   // golden-signal tiles
  waiting: Presence[];                            // agents blocked / needing input, oldest-first
  oldestWaitingTs?: number;                       // "oldest unattended"
  dms:     DmPeer[];                              // per-peer DM roll-up → threads (god-view only)
}
```

`dms` is populated only when DMs are visible (god-view / open mode); it groups unicast traffic
into per-peer conversations — only pairs that actually talked, never the n² cross-product.

## Feature → surface map

| feature | model field | console (Ink) | stream | web |
|---|---|---|---|---|
| roster (status, activity, age) | `agents` / `endpoints` | ✓ panel | ✓ presence lines | ✓ sidebar |
| all-activity feed | `feed` | ✓ feed panel | ✓ log | ✓ Monitor view |
| channels + counts | `channels` | ✓ tabs (1–9) | — | ✓ sidebar + Channel view |
| golden-signal counts | `signals.counts` | ✓ tiles strip | — | ✓ tiles |
| needs-you / blocked | `signals.waiting` | ✓ rail (`n`) | — | ✓ NEEDS-YOU rail |
| direct-message lens | `signals.dms` | ✓ lens (`d`) | — | ✓ DM view |
| topology lens (who-talks-to-whom) | `feed` + `agents` (derived) | ✓ lens (`t`, 3 variants) | — | — |
| message / agent **detail** | `feed` / `agents` | ✓ select → detail | — | ✓ row / thread |
| **search / filter** | client | ✓ `/` | (grep) | ✓ mode chips |
| msgs/s, connected, dmVisible | `rates` / `status` | ✓ status bar | — | ✓ conn pill |

Both interactive surfaces now render every model field. The console adds the signals as a one-row
tiles strip (always on), a NEEDS-YOU rail toggled with `n` (a side column when the terminal is wide,
else a full-screen overlay), and a DM lens toggled with `d` (peer roll-up + thread; shows
"DMs hidden" under chat-only creds). The stream is line-oriented, so the signals stay out of it.
The topology lens (`t`) folds the feed + roster into a who-talks-to-whom graph client-side and
renders it three switchable ways (`v` / `1-3`): swimlane sequence, adjacency heat matrix, and a
ring node-link map with channels/roles as hub nodes.

## Future — not yet on the wire

The web's `?demo` scene also mocks features that **no protocol message backs yet** — they render
only as the static Penpot reference, never from live data, and are deliberately *not* implemented on
either live surface. They live here as design intent until the wire grows to support them:

| flourish | what it would need |
|---|---|
| intent badges ("about to act") | a new intent message kind / field on the wire |
| approval requests (approve / deny) | a request message kind + a response path (interactive) |
| task-failed alerts | a failure signal — a manager lifecycle event or a presence status |
| unclaimed-anycast / status roll-up | mostly derivable from existing traffic; a `MeshView` signal |
| per-conversation unread | per-viewer client state, not really protocol |

## Principles

- **Derive once, render many.** Classification, coalescing, sorting, id→name, rate, windowing,
  and the operator signals live in `MeshView`. A surface only *lays out* the model — it never
  re-derives it. New surfaces are thin clients.
- **Presentation stays per-surface.** Color palette (`agentColor`), layout, CSS, keybindings,
  and input handling belong to each renderer, not the model.
- **No fallbacks.** If the observer can't do what a surface needs, throw — don't silently degrade.
- **Status is shape *and* color.** `● working · ◐ waiting · ○ idle · ⨯/⊘ offline` — never color
  alone (accessibility).
