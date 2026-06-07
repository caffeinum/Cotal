# console-ink SPEC

A lazygit-style **Ink** TUI for the Cotal console — a multi-panel live dashboard
(roster · channel tabs · message feed) rendered **over the existing read-only
`CotalEndpoint` observer**. It is a port of the ANSI dashboard in
`implementations/cli/src/render.ts` (`runDashboard`) — same data, richer UI.

Source research: `examples/04-self-improving-console/research/INPUT.md`.
Verified against `@cotal/core` (`endpoint.ts`, `types.ts`) and `commands/console.ts` —
every method/event/type named below exists today.

## Load-bearing decisions (verified)

- **Ink (vadimdemedes/ink) ≥ 6.** ESM-only, Node ≥ 20, React ≥ 19 — matches this repo
  (ESM, Node ≥ 20, runs `.tsx` via `tsx`, no build step). Stock Ink is enough at our scale.
- **Render over the existing observer — do NOT open a new NATS connection.** The console
  command (`commands/console.ts`) already builds the read-only endpoint; the Ink app
  consumes *that* via `useMesh()`. Re-confirmed below.
- **Skip OpenTUI** (Bun-only today). **Avoid blessed** (unmaintained).

## The observer contract we build on

`commands/console.ts` constructs the observer — reuse this verbatim for the `console-ink`
command (just `render(<App .../>)` instead of `runDashboard`):

```ts
const ep = new CotalEndpoint({
  space, servers: server, creds,
  channels: [],
  consume: false,          // observer: no inbox, binds no durables — invisible to peers
  registerPresence: false,
  watchPresence: true,
  card: { name: "console", kind: "endpoint" },
});
// open mode taps the whole space; under auth pass chatWildcard(space)
const tapSubject = creds ? chatWildcard(space) : undefined;
```

**Endpoint API the data layer uses (all confirmed in `endpoint.ts`):**

| Surface | Signature | Notes |
|---|---|---|
| presence snapshot | `ep.getRoster(): Presence[]` | sorted by name; works on observer |
| roster event | `ep.on("roster", (r: Presence[]) => …)` | full sorted snapshot on every change — **render this, not an event log** |
| presence event | `ep.on("presence", (ev: PresenceEvent) => …)` | `{type:"join"\|"update"\|"offline", presence}` — for transient hints only |
| error event | `ep.on("error", (e: Error) => …)` | surface in status bar / feed |
| live feed | `ep.tap((subject, msg?) => …, { subject? })` | read-only sub; `msg` is `undefined` for non-JSON frames |
| channel list | `ep.listChannels(): Promise<{channel, messages}[]>` | from JetStream subject counts; works on observer |
| channel backlog | `ep.channelHistory(channel, {limit?}): Promise<CotalMessage[]>` | prefill a tab on first view |
| lifecycle | `await ep.start()` **then** `ep.tap(...)`; `await ep.stop()` | start before tapping (see `render.ts`) |

There is **no `"message"` event** for us — that fires only for a *consumed* inbox, and the
observer sets `consume:false`. The feed comes entirely from `tap`.

**Subject classification.** `deliveryOf(subject)` → `"multicast" | "unicast" | "anycast" | null`.
`null` = control/trace/presence frame → **drop from the feed** (not peer traffic). This is
how `render.ts` filters; keep it.

## Types (from `@cotal/core`)

```ts
Presence       { card: AgentCard; status: PresenceStatus; activity?: string; ts: number }
AgentCard      { id; name; kind: "agent"|"endpoint"|…; role?; description?; tags?; … }
PresenceStatus "idle" | "waiting" | "working" | "offline"
CotalMessage   { id; ts; space; from: EndpointRef; channel?; to?; toService?; parts: Part[]; replyTo?; contextId? }
EndpointRef    { id; name; role? }
Part           { kind:"text"; text } | { kind:"data"; data }
```

Delivery target on a message: exactly one of `channel` (multicast), `to` (unicast, an
**instance id** — must be resolved to a name), `toService` (anycast).

## Data the UI needs

1. **Roster** — `Presence[]` snapshot. Split `card.kind === "agent"` (status dot + activity +
   age) from endpoints (dimmed). Sort working → waiting → idle → offline, then name.
2. **Channels** — `listChannels()` output for the tab strip + counts; refresh periodically.
3. **Feed** — tapped messages, classified, body = `parts` joined, **coalesced** (group
   same-sender/same-text unicast bursts), **windowed** (cap ~300), filtered by active channel.
4. **id → name resolution** — unicast `to` is an id; keep a `byId` map off the roster snapshot.
5. **Liveness** — connected flag, current space, a `msgs/s` rate, last-seen ages (`ago(ts)`).

`render.ts` already implements the non-trivial pieces — **reuse the logic** (not the ANSI):
`RosterIndex` (status-sort + `byId`), `Fanout` (400 ms burst coalescer; anycast→`@svc`,
multicast→`#chan`), the 300-entry window, and `agentColor` (stable name→color hash).

## `useMesh()` — STARTING PROPOSAL

> **Proposal only — `backend` (owns `mesh.ts`) and `tui-designer` (owns `app.tsx`/`ui/`)
> finalize this shape together over the mesh.** It is the contract both sides depend on.

The `console-ink` command creates the observer endpoint (as above) and passes it to the Ink
root; `useMesh` wraps it. Keeps "one connection" and "data layer usable from non-TUI code".

```ts
function useMesh(ep: CotalEndpoint, opts?: { activeChannel?: string; window?: number }): MeshState

interface MeshState {
  agents:    Presence[];                          // card.kind === "agent", status-sorted
  endpoints: Presence[];                          // everything else, dimmed
  channels:  { channel: string; messages: number }[];
  feed:      FeedEntry[];                          // coalesced + windowed, filtered to activeChannel
  status:    { connected: boolean; space: string; error?: string };
  rates:     { msgsPerSec: number };
  nameOf:    (id: string) => string;              // unicast target id → display name
}

interface FeedEntry {
  id: string;
  ts: number;
  from: EndpointRef;
  delivery: "multicast" | "unicast" | "anycast";
  channel?: string;        // multicast
  toService?: string;      // anycast
  toNames?: string[];      // unicast targets, resolved (coalesced bursts)
  count?: number;          // burst multiplicity for coalesced unicast
  text: string;            // parts rendered to a string
}
```

Open questions for backend ↔ tui-designer to settle: hook-returns-state vs. external store +
context; whether feed filtering lives in the hook or the component; how `channelHistory`
prefill composes with the live `tap` (dedupe by `id`); update batching (a 50–100 ms ticker
into React state rather than per-message `setState`).

## Target UX (lazygit-inspired)

- **Roster panel** (left) — always visible. Agents: colored name, status dot
  (`● working / ◐ waiting / ○ idle / ⨯ offline`), activity, `ago(ts)`. Endpoints dimmed below.
- **Channel tabs** (top) — from `listChannels()`. `1`–`9` jump directly, `Tab` cycles;
  switching swaps the feed filter. Show counts.
- **Live feed** (main panel) — coalesced, word-wrapped, windowed. **Auto-scroll to bottom
  unless the user scrolled up** (track `pinnedToBottom`). Mouse wheel + PgUp/PgDn/Home/End.
- **Multi-panel focus** — `useFocus` / `useFocusManager`; number keys for direct jumps;
  focused panel gets a highlighted border.
- **Status bar** (bottom) — connected state, current channel, `msgs/s`, the keybindings
  relevant to the focused panel.
- **`?` help overlay** — modal that takes focus; lists **only** the focused context's
  keybindings (context-sensitive), dismiss to restore. `q` / Ctrl-C quits.

## Render / perf config

- `render(<App/>, { /* Ink ≥6 */ })` with incremental rendering and `maxFps: ~30`.
- Keep dynamic output **shorter than terminal height**; use `<Static>` only for *finalized*
  scrollback (it is append-only, not a scroll view) — keep the live tail in normal state.
- Coalesce JetStream messages into state on a 50–100 ms ticker; cap the feed window.
- Resize via `useStdout()` (`columns`/`rows`); plan a stacked fallback below ~80 cols.

## File ownership

- `mesh.ts` — **backend**: `useMesh()` data layer over the observer.
- `app.tsx`, `ui/*` — **tui-designer**: panels, focus, keymaps, `?` overlay, render config.
- new `console-ink` command — wires the observer endpoint into `render(<App/>)`, mirroring
  `commands/console.ts`.
- This SPEC — **research**. Don't put code here.
