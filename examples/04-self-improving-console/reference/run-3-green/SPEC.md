# Console TUI — SPEC

Port the live ANSI dashboard (`implementations/cli/src/render.ts` → `runDashboard`) to a
lazygit-style Ink TUI. Same data, same read-only observer — richer, multi-panel layout.

**Framework: Ink 6 + React 19.** Already declared in `implementations/cli/package.json`
(`ink ^6`, `@inkjs/ui ^2`, `react ^19`, `@types/react ^19`). ESM + Node ≥20 + `tsx` — no
build step. This is settled; don't re-litigate (OpenTUI is Bun-only, blessed is dead).

## Hard constraint: reuse the existing observer

Do **not** open a new NATS connection. `commands/console.ts` already builds the observer and
picks a render path. Keep that: it constructs

```ts
new CotalEndpoint({ space, servers, creds, channels: [], consume:false,
  registerPresence:false, watchPresence:true, card:{ name:"console", kind:"endpoint" } })
```

and computes `tapSubject` (`chatWildcard(space)` under auth — DMs/anycast stay confidential;
`undefined` = whole space in open mode). The Ink app gets that *same* endpoint. Add one entry
mirroring `runDashboard`'s signature:

```ts
export async function runInk(ep: CotalEndpoint, space: string, tapSubject?: string): Promise<void>
```

`console.ts` calls `runInk` instead of `runDashboard` on the TTY path; `runLog` stays the
`--plain` / non-TTY fallback. `render.ts` is **not** modified — it remains the watch/plain path.

## Verified `CotalEndpoint` surface (the only API the data layer touches)

| Member | Shape | Use |
|---|---|---|
| `start()` / `stop()` | `Promise<void>` | lifecycle (hook owns it) |
| `on("roster", cb)` | `cb(r: Presence[])` | full sorted snapshot on every change |
| `on("presence", cb)` | `cb(ev: PresenceEvent)` | join/update/offline (for transient hints) |
| `on("error", cb)` | `cb(e: Error)` | surface in status bar / feed |
| `getRoster()` | `Presence[]` | initial snapshot before first event |
| `tap(handler, opts?)` | `handler(subject: string, msg: CotalMessage \| undefined)`, `opts={subject}` | live message feed; pass `{ subject: tapSubject }` when set |
| `listChannels()` | `Promise<{channel:string; messages:number}[]>` | tab list + counts (async; needs started ep) |
| `channelHistory(ch,{limit})` | `Promise<CotalMessage[]>` | pre-fill a tab's backlog on first view |

Types (from `@cotal/core`):
- `Presence { card: AgentCard; status: PresenceStatus; activity?: string; ts: number }`
- `AgentCard { id; name; kind: "agent"|"endpoint"; role?; … }`
- `PresenceStatus = "idle" | "waiting" | "working" | "offline"`
- `CotalMessage { id; ts; from: EndpointRef; channel?; to?; toService?; parts: Part[]; … }`
- `EndpointRef { id; name; role? }`; `Part = {kind:"text";text} | {kind:"data";data}`
- `deliveryOf(subject) → "chat" | "anycast" | "unicast" | null` — classify a tapped subject;
  `null` = control/trace, **drop it** (not peer traffic).

## Reuse the domain logic from `render.ts` (lift the logic, drop the ANSI)

These are already written and correct — port them into the data layer as structured data
(no ANSI strings); the *visuals* move into Ink `<Text>`:
- **agent color** — `agentColor`'s name-hash → palette index. In Ink, map the index to a hex/
  named `color` prop instead of an ANSI-wrapping fn. Palette deliberately avoids status hues.
- **`ago(ts)`** — relative age string for the roster.
- **STATUS map** — `working ●` green / `waiting ◐` yellow / `idle ○` gray / `offline ⨯` dim.
- **roster sort** — status order (`working<waiting<idle<offline`) then name (`RosterIndex`).
- **Fanout coalescing** — collapse same-sender + same-text unicast bursts within ~400ms into
  one `→ a, b, c (3×)` entry; pass multicast/anycast through; drop non-peer subjects via
  `deliveryOf`. Port it to emit **structured `FeedEntry`s**, not display strings.
- **text(msg)** — `parts.map(p => p.kind==="text"?p.text:JSON.stringify(p.data)).join(" ")`.

## Target UI (lazygit-style — everything visible at once)

```
┌ COTAL · <space> ──────────────────────────────── N agents · M endpoints ┐
│ ROSTER (left)            │ [all] [team] [general] [#…]   ← channel tabs   │
│  ● backend   working     │ ───────────────────────────────────────────── │
│    …activity…       3s   │ 12:30:01 backend → #team:  feed (main panel)   │
│  ◐ research  waiting     │ 12:30:02 research → @backend: …                │
│  ○ manager   idle        │ …coalesced, windowed, auto-scrolls to tail…    │
│  ⚙ console   endpoint    │                                                │
├──────────────────────────┴───────────────────────────────────────────────┤
│ ● connected · #team · 4 msgs/s · Tab cycle · 1–9 jump · ? help · q quit   │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Roster panel** (left): agents (`kind==="agent"`) first with status dot+word, activity,
  age; endpoints below, dimmed with `⚙`. Focusable list. Mirrors the current dashboard column.
- **Channel tabs** (top of main): `all` + one per `listChannels()` channel. `all` = every
  tapped message (current dashboard behavior); a channel tab filters `feed` to
  `entry.channel === tab`. **Unicast DMs / anycast have no channel → they live in `all` only**
  (and are only visible in open mode anyway). `1`–`9` jump, `Tab`/`←`/`→` cycle.
- **Feed** (main): coalesced entries for the active tab, windowed (cap ~300, like today).
  Auto-scroll to tail unless the user scrolled up — track `pinnedToBottom`. Port the existing
  scroll semantics: arrows/wheel, PgUp/PgDn, `g` top, `G`/`End` follow tail.
- **Status bar** (bottom): connected state, active channel, `msgs/s` rate, context keys.
- **Help overlay** (`?`): modal that takes focus until dismissed; lists the **focused
  context's** keymap (lazygit-style, auto context-sensitive). Esc/`?` closes.

**Focus model:** `useFocus` + `useFocusManager`; number keys jump tabs; `Tab` cycles focus
roster↔feed; `?` help; `q`/Ctrl-C quit. **Ink render options:** clamp FPS and enable
incremental rendering (confirm exact option names against installed Ink 6); keep dynamic
output shorter than terminal height to dodge the full-clear flicker path; `<Static>` only for
finalized scrollback if needed. Resize via `useStdout()` `columns`/`rows`; plan a stacked
fallback below ~80 cols. Theme = one semantic TS object (`focusedBorder`, `agentWorking`, …)
via React Context.

## `useMesh()` — STARTING PROPOSAL (backend + tui-designer finalize together)

This is the contract seam between the data layer and the UI. **Proposal, not final** — ratify
the exact shape before building against it.

```ts
function useMesh(ep: CotalEndpoint, opts: { tapSubject?: string }): MeshState

interface MeshState {
  roster: Presence[];                 // sorted snapshot (on("roster") / getRoster())
  channels: { channel: string; messages: number }[];  // listChannels(), refreshed
  feed: FeedEntry[];                  // coalesced + windowed; ALL traffic, filtered by UI
  connected: boolean;
  rate: number;                       // msgs/s, sliding window (status bar)
  error?: string;
}

interface FeedEntry {
  id: string;                         // msg.id (synthetic for a coalesced burst)
  ts: number;
  from: EndpointRef;
  delivery: "chat" | "unicast" | "anycast";
  channel?: string;                   // set when delivery==="chat" (tab filter key)
  toService?: string;                 // set when delivery==="anycast"
  toNames?: string[];                 // recipient display names when delivery==="unicast"
  text: string;
}
```

The hook owns lifecycle: `start()` on mount, wire `on("roster"|"presence"|"error")` + `tap()`,
run the Fanout-port to produce `FeedEntry`s, `stop()` on unmount. The UI filters `feed` by the
active tab — single source of truth, no per-channel buckets in the hook. Open questions for the
two of you: (1) should `channelHistory()` backfill a tab on first view, or feed-only? (2) where
do DM/anycast render — `all`-only as proposed, or a synthetic `direct` tab? (3) batch tap
updates on a 50–100ms ticker into state vs. per-message `setState`.

## Suggested file layout & division of labor

```
src/console/
  index.tsx        # runInk(ep, space, tapSubject): render(<App/>)         [tui-designer]
  app.tsx          # root: context/focus mgr, layout, global keys, help    [tui-designer]
  ui/*.tsx         # RosterPanel, ChannelTabs, Feed, StatusBar, HelpOverlay [tui-designer]
  theme.ts         # semantic color tokens                                  [shared]
  mesh.ts          # useMesh + Fanout port + lifecycle                      [backend]
```

- **backend** → `mesh.ts`: the hook, the Fanout/agent-color/ago/text ports, rate, lifecycle.
- **tui-designer** → `index.tsx`, `app.tsx`, `ui/*`: layout, focus, tabs, scroll, help, theme.
- **Both** → ratify `MeshState` / `FeedEntry` before depending on it; that's the only seam.
