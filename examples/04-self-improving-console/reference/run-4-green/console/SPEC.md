# console-ink SPEC

A lazygit-style Ink/React rebuild of cotal's live console, shipped as a **new
`cotal console-ink` command** (the classic `cotal console` in `render.ts` stays untouched).

> Author: `research`. **backend** owns the data layer (`mesh.ts`), **tui-designer** owns the
> UI (`app.tsx` + `ui/`). The `useMesh()` shape below is a **PROPOSAL** — backend and
> tui-designer settle the final interface peer-to-peer. Everything under "Observer data" and
> "Load-bearing facts" is verified against the real source and is not negotiable.

## Load-bearing facts (verified)

- **Render over the EXISTING read-only observer — never a new NATS client.** The command
  constructs the same `CotalEndpoint` as `commands/console.ts`:
  `{ channels: [], consume: false, registerPresence: false, watchPresence: true }`. It is
  invisible to peers (no presence, no inbox). The placeholder `commands/console-ink.tsx`
  already wires this; keep it.
- **This is a port of the ANSI dashboard** `runDashboard()` in `implementations/cli/src/render.ts`.
  Reuse its proven logic (below); do not re-derive the protocol.
- **Stack:** Ink ≥6 + React 19, ESM, run via `tsx`. Already a dependency (the placeholder
  imports `render, Box, Text, useApp, useInput` from `ink`). Skip OpenTUI (Bun-only today).

## Observer data available (the data contract)

Everything the UI can show comes from these `CotalEndpoint` members — all work on a
read-only observer, no consumers/durables needed:

| Member | Shape | Notes |
|---|---|---|
| `ep.getRoster()` | `Presence[]` | snapshot, sorted by name |
| `ep.on("roster", (r: Presence[]) => …)` | full snapshot on every change | **render current state, not an event log** |
| `ep.on("presence", (ev: PresenceEvent) => …)` | `{type:"join"\|"update"\|"offline", presence}` | optional — for join/leave flashes only |
| `ep.on("error", (e: Error) => …)` | — | surface in a status line |
| `ep.tap((subject, msg) => …, { subject })` | live feed of every message | `msg` is `CotalMessage \| undefined`; **defaults to whole space** |
| `ep.listChannels()` | `Promise<{channel, messages}[]>` | the channel tabs + counts |
| `ep.channelHistory(channel, {limit})` | `Promise<CotalMessage[]>` | backlog hydrate on tab open |
| `ep.start()` / `ep.stop()` | lifecycle | start AFTER wiring listeners (see render.ts) |

### Types (`@cotal/core`)

```ts
Presence    { card: AgentCard; status: PresenceStatus; activity?: string; ts: number }
AgentCard   { id; name; kind: "agent"|"endpoint"; role?; description?; tags?; ... }
PresenceStatus = "idle" | "waiting" | "working" | "offline"
CotalMessage{ id; ts; space; from: EndpointRef; parts: Part[]; replyTo?; contextId?;
              // exactly one delivery target is set:
              channel?;      // multicast → a channel
              to?;           // unicast → an instance id (resolve to a name via roster)
              toService?;    // anycast → a role/service name
            }
EndpointRef { id; name; role? }
Part        = { kind:"text"; text } | { kind:"data"; data }
deliveryOf(subject) -> "chat" | "anycast" | "unicast" | null   // null = control/trace; DROP it
```

### Two facts the feed MUST handle

1. **Filter non-peer traffic.** `tap` delivers *every* subject (control, trace, …).
   `deliveryOf(subject) === null` → skip it (render.ts does exactly this).
2. **Auth narrows the feed.** Open/dev mode: tap sees the whole space (channels + DMs + anycast).
   Under creds the observer may only `tap(chatWildcard(space))` → **channels only** (DM/anycast
   stay confidential). The command already picks `tapSubject = creds ? chatWildcard(space) : undefined`.
   The UI must degrade gracefully when DM/anycast aren't present.

## Reuse from `render.ts` — don't reinvent (backend)

- `agentColor(name)` — stable per-agent color hash (port the hashing; map to an Ink-friendly
  color/hex, since Ink uses `<Text color=…>` not ANSI fns).
- `RosterIndex` — sorts roster by status (`working→waiting→idle→offline`) then name; `nameOf(id)`
  resolves unicast `to` ids to names.
- `Fanout` — coalesces same-sender/same-text **unicast bursts** within ~400ms into one entry
  (the "→ a, b (3×)" lines). Port the *coalescing logic* but emit **structured** entries (sender
  ref + target + body + count), not pre-colored ANSI strings.
- Feed is windowed: render.ts caps the log at 300 entries — keep an upper bound, never unbounded.

## Target UI surface (lazygit layout)

```
┌ COTAL · <space> ───────────────────────────── N agents · M endpoints ┐
│ [ all ]  team  backend  general          ← channel tabs (1–9 jump, Tab cycles)
├──────────────┬──────────────────────────────────────────────────────┤
│ ROSTER       │  FEED (main panel)                                     │
│ ● backend    │  12:01:03  backend → #team: useMesh draft ready        │
│   working …  │  12:01:05  research → @backend: see SPEC §data         │
│ ◐ tui-design │  …auto-scrolls to tail unless pinned (scrolled up)     │
│ ○ manager ⚙  │                                                        │
├──────────────┴──────────────────────────────────────────────────────┤
│ ● connected · #team · 4 msgs/s · ↑/↓ scroll · Tab panel · ? help      │  ← status bar
└──────────────────────────────────────────────────────────────────────┘
```

- **Roster panel (left).** Live `Presence` snapshot. Agents (`card.kind==="agent"`) above
  plain endpoints (`⚙`, dimmed). Per row: status dot + tint (working green / waiting yellow /
  idle gray / offline dim), name (stable color), activity, last-seen age (`ago(ts)`).
- **Channel tabs (top).** From `listChannels()` + a leading **`all`** pseudo-tab (unfiltered
  feed). `1`–`9` jump, `Tab` cycles. Switching a tab swaps the feed filter; on first open,
  hydrate via `channelHistory(channel)`.
- **Feed (main panel).** Coalesced, time-stamped `sender → target: body` entries. Auto-scroll to
  tail; track a `pinnedToBottom` boolean — when the user scrolls up, stop following and show an
  "↑ N more · End to follow" hint (mirror render.ts scroll semantics).
- **Focus (multi-panel).** `useFocus` + `useFocusManager`; number keys for direct jumps. Focused
  panel gets a highlighted border; arrow keys drive the focused panel only.
- **Status bar (bottom).** Connection dot, current channel, `msgs/s` rate, and the keybindings
  valid for the focused context.
- **`?` help overlay.** A modal that takes focus until dismissed; **derive its contents from the
  focused context's keymap** so it's automatically context-sensitive. `q`/`Esc` to quit/close.

## Data the UI needs → `useMesh()` (PROPOSAL — backend + tui-designer finalize)

A single hook in `src/console/mesh.ts` wrapping the existing `ep`. UI imports nothing from
`@cotal/core` directly; the hook is the only seam.

```ts
interface FeedEntry {
  id: string; ts: number;
  from: EndpointRef;
  delivery: "chat" | "unicast" | "anycast";
  channel?: string;        // chat
  toNames?: string[];      // unicast targets, id→name resolved + coalesced
  toService?: string;      // anycast role
  text: string;            // parts flattened to a string
  count?: number;          // coalesced burst size (>1 ⇒ show "(N×)")
}

interface Mesh {
  roster:   Presence[];                              // live, sorted (status→name)
  channels: { channel: string; messages: number }[]; // tabs + counts (+ "all" added in UI)
  feed:     FeedEntry[];                             // windowed, newest last; filter by channel in UI
  connected: boolean;
  msgsPerSec: number;
  nameOf(id: string): string;                        // roster-backed id → display name
  colorOf(name: string): string;                     // stable Ink color per agent
  loadHistory(channel: string): Promise<void>;       // hydrate a tab via channelHistory()
}

function useMesh(ep: CotalEndpoint, opts?: { tapSubject?: string; window?: number }): Mesh
```

- The hook owns: roster/presence subscriptions, the `tap` feed (filtering `deliveryOf===null`),
  coalescing, the rolling window, and the msgs/s counter. **Panel focus / selected tab / scroll
  position are UI state (tui-designer), not mesh state.**
- `ep` is passed in already-constructed (the command builds it); the hook calls `ep.start()` in an
  effect and `ep.stop()` on cleanup — or the command starts it. backend + tui-designer decide which.

## Rendering rules (from research; non-negotiable for smoothness)

- `render(<App/>, { incrementalRendering: true, maxFps: 30 })`. Keep dynamic output shorter than
  the terminal height (Ink full-clears otherwise → flicker).
- **Coalesce state updates**: batch tapped messages with a ~50–100ms ticker into React state, not
  one `setState` per message.
- Consider `<Static>` for finalized scrollback and a small live tail; `useStdout()` for
  `columns`/`rows` + resize. Below ~80 cols, plan a stacked portrait fallback.

## Open questions for backend + tui-designer

1. Final `useMesh()` interface (names, who calls `start()/stop()`, history-on-tab vs eager).
2. `colorOf` return type — named Ink colors vs hex (Ink doesn't take 256-palette indexes directly).
3. Whether to keep a separate presence-flash line or render roster state only (render.ts does state-only).
