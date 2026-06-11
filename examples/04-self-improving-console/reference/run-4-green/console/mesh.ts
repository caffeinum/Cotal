// Data layer for the Ink console: a `useMesh()` hook over the read-only
// `CotalEndpoint` observer (see ../commands/console.ts for the observer config).
// Reuses the passed endpoint — never opens its own NATS connection — and owns its
// lifecycle (start → tap → stop). Returns UI-ready state for the Ink panels.
//
// Interface settled peer-to-peer with tui-designer; treat `MeshState` as the contract.

import { useCallback, useEffect, useRef, useState } from "react";
import { deliveryOf } from "@cotal-ai/core";
import type { CotalEndpoint, Presence, CotalMessage } from "@cotal-ai/core";

// ---- public contract -------------------------------------------------------

/** One roster row — a flattened `Presence`, agents and endpoints alike. */
export interface AgentRow {
  id: string;
  name: string;
  role?: string;
  kind: "agent" | "endpoint";
  status: "idle" | "waiting" | "working" | "offline";
  activity?: string;
  lastSeenMs: number;
}

/** A channel with its JetStream total and unread-since-last-`markRead` count. */
export interface ChannelRow {
  name: string;
  count: number;
  unread: number;
}

/** One feed line. Unicast bursts are coalesced; `to` holds the resolved targets. */
export interface FeedEntry {
  id: string;
  ts: number;
  kind: "multicast" | "unicast" | "anycast";
  from: { name: string; role?: string };
  to?: string[]; // unicast: resolved recipient names (coalesced)
  toService?: string; // anycast: target role/service
  channel?: string; // multicast: channel name
  text: string;
}

export interface MeshState {
  roster: AgentRow[];
  channels: ChannelRow[];
  feed: FeedEntry[];
  status: { connected: boolean; space: string };
  /** Clear a channel's unread count (call on tab switch / view). */
  markRead(channel: string): void;
}

export interface UseMeshOptions {
  /** Narrow the tap (auth: pass chatWildcard(space)); default taps the whole space. */
  tapSubject?: string;
  /** Max feed entries retained (default 500). */
  window?: number;
  /** Per-channel backlog seeded on mount (default 50). */
  historyLimit?: number;
}

// ---- tuning ----------------------------------------------------------------

const BURST_MS = 400; // unicast fan-out coalescing window
const DEFAULT_WINDOW = 500;
const DEFAULT_HISTORY = 50;
const CHANNELS_REFRESH_MS = 4000;

const STATUS_ORDER: Record<string, number> = { working: 0, waiting: 1, idle: 2, offline: 3 };

// ---- internal mutable model (lives across renders via a ref) ---------------

interface Pending {
  base: FeedEntry; // sender/text/ts/id; `to` filled at flush
  ids: string[]; // recipient instance ids gathered during the burst
  timer: ReturnType<typeof setTimeout>;
}

interface Model {
  feed: FeedEntry[];
  seen: Set<string>; // feed ids, for dedup (seed vs live overlap)
  byId: Map<string, string>; // instance id → name
  pending: Map<string, Pending>;
  totals: Map<string, number>; // channel → JetStream message total (from listChannels)
  unread: Map<string, number>; // channel → live multicasts since last markRead
}

// ---- pure helpers ----------------------------------------------------------

function textOf(m: CotalMessage): string {
  return m.parts.map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ");
}

function toRow(p: Presence): AgentRow {
  return {
    id: p.card.id,
    name: p.card.name,
    role: p.card.role,
    kind: p.card.kind,
    status: p.status,
    activity: p.activity,
    lastSeenMs: p.ts,
  };
}

/** Agents first, then by status (working→offline), then by name — matches the dashboard. */
function sortRoster(list: Presence[]): AgentRow[] {
  return list
    .map(toRow)
    .sort(
      (a, b) =>
        (a.kind === "agent" ? 0 : 1) - (b.kind === "agent" ? 0 : 1) ||
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        a.name.localeCompare(b.name),
    );
}

/** Channel rows from totals + unread, union of both key sets, sorted by name. */
function channelRows(m: Model): ChannelRow[] {
  const names = new Set<string>([...m.totals.keys(), ...m.unread.keys()]);
  return [...names]
    .sort()
    .map((name) => ({ name, count: m.totals.get(name) ?? 0, unread: m.unread.get(name) ?? 0 }));
}

// ---- the hook --------------------------------------------------------------

export function useMesh(ep: CotalEndpoint, opts: UseMeshOptions = {}): MeshState {
  const [roster, setRoster] = useState<AgentRow[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const m = useRef<Model>({
    feed: [],
    seen: new Set(),
    byId: new Map(),
    pending: new Map(),
    totals: new Map(),
    unread: new Map(),
  }).current;

  // Latest opts without re-running the lifecycle effect when the object identity changes.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const markRead = useCallback(
    (channel: string) => {
      if (!m.unread.has(channel)) return;
      m.unread.set(channel, 0);
      setChannels(channelRows(m));
    },
    [m],
  );

  useEffect(() => {
    const { tapSubject, window = DEFAULT_WINDOW, historyLimit = DEFAULT_HISTORY } = optsRef.current;
    let stopped = false;
    let scheduled = false;

    // Coalesce bursty feed mutations into one setState per microtask.
    const schedule = () => {
      if (scheduled || stopped) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!stopped) setFeed(m.feed.slice());
      });
    };

    const push = (e: FeedEntry): boolean => {
      if (m.seen.has(e.id)) return false;
      m.seen.add(e.id);
      // Keep ascending ts: live appends at the tail; seed/out-of-order back-fills.
      const last = m.feed[m.feed.length - 1];
      if (!last || e.ts >= last.ts) m.feed.push(e);
      else {
        let i = m.feed.length;
        while (i > 0 && m.feed[i - 1].ts > e.ts) i--;
        m.feed.splice(i, 0, e);
      }
      while (m.feed.length > window) m.seen.delete(m.feed.shift()!.id);
      schedule();
      return true;
    };

    const flushBurst = (key: string) => {
      const p = m.pending.get(key);
      if (!p) return;
      m.pending.delete(key);
      const to = p.ids.map((id) => m.byId.get(id) ?? id.slice(0, 8));
      push({ ...p.base, to });
    };

    const ingest = (subject: string, msg: CotalMessage) => {
      const d = deliveryOf(subject); // "chat" | "unicast" | "anycast" | null
      if (!d) return; // control/trace — not peer traffic
      if (d === "unicast") {
        const text = textOf(msg);
        const key = msg.from.id + "\n" + text;
        let p = m.pending.get(key);
        if (!p) {
          const base: FeedEntry = {
            id: msg.id,
            ts: msg.ts,
            kind: "unicast",
            from: { name: msg.from.name, role: msg.from.role },
            text,
          };
          p = { base, ids: [], timer: setTimeout(() => flushBurst(key), BURST_MS) };
          m.pending.set(key, p);
        }
        if (msg.to) p.ids.push(msg.to);
        return;
      }
      const added = push({
        id: msg.id,
        ts: msg.ts,
        kind: d === "chat" ? "multicast" : "anycast",
        from: { name: msg.from.name, role: msg.from.role },
        channel: msg.channel,
        toService: msg.toService,
        text: textOf(msg),
      });
      // Live multicast bumps the channel's unread count (seed backlog never does).
      if (added && d === "chat" && msg.channel) {
        m.unread.set(msg.channel, (m.unread.get(msg.channel) ?? 0) + 1);
        if (!stopped) setChannels(channelRows(m));
      }
    };

    const onRoster = (list: Presence[]) => {
      m.byId = new Map(list.map((p) => [p.card.id, p.card.name]));
      if (!stopped) setRoster(sortRoster(list));
    };

    const applyTotals = (list: { channel: string; messages: number }[]) => {
      m.totals = new Map(list.map((c) => [c.channel, c.messages]));
      if (!stopped) setChannels(channelRows(m));
    };

    ep.on("roster", onRoster);

    const channelsTick = setInterval(() => {
      ep.listChannels().then(applyTotals, () => {});
    }, CHANNELS_REFRESH_MS);

    void (async () => {
      await ep.start();
      if (stopped) return;
      setConnected(true);
      onRoster(ep.getRoster()); // current snapshot; live "roster" events refine it
      ep.tap(
        (subject, msg) => {
          if (msg) ingest(subject, msg);
        },
        tapSubject ? { subject: tapSubject } : undefined,
      );
      // Seed the feed with recent per-channel backlog, then live tap takes over.
      const list = await ep.listChannels();
      if (stopped) return;
      applyTotals(list);
      const histories = await Promise.all(
        list.map((c) => ep.channelHistory(c.channel, { limit: historyLimit }).then((x) => x, () => [])),
      );
      if (stopped) return;
      for (const msg of histories.flat().sort((a, b) => a.ts - b.ts))
        push({
          id: msg.id,
          ts: msg.ts,
          kind: "multicast",
          from: { name: msg.from.name, role: msg.from.role },
          channel: msg.channel,
          text: textOf(msg),
        });
    })().catch(() => {
      if (!stopped) setConnected(false);
    });

    return () => {
      stopped = true;
      clearInterval(channelsTick);
      for (const p of m.pending.values()) clearTimeout(p.timer);
      m.pending.clear();
      void ep.stop();
    };
  }, [ep]);

  return {
    roster,
    channels,
    feed,
    status: { connected, space: ep.space },
    markRead,
  };
}
