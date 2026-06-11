// Data layer for the Ink console: a read-only `useMesh()` hook over an already-started
// `CotalEndpoint` observer. The owning command constructs + start()s the endpoint and
// stop()s it on exit (see ../commands/console.ts for the observer recipe); the hook only
// subscribes — it never opens a connection or starts/stops the endpoint.
//
// The exported shapes below are the contract settled with tui-designer (the UI side).

import { useEffect, useState } from "react";
import {
  deliveryOf,
  type CotalEndpoint,
  type CotalMessage,
  type EndpointRef,
  type Presence,
} from "@cotal-ai/core";

// ---- public contract -------------------------------------------------------

export interface RosterEntry extends Presence {
  /** ms since last heartbeat (now - ts); recomputed every snapshot. */
  ageMs: number;
  /** card.kind === "agent" (vs a plain endpoint like a logger/console). */
  isAgent: boolean;
}

export interface ChannelInfo {
  channel: string;
  /** Messages seen on this channel (backlog seed + live). */
  messages: number;
}

export type FeedKind = "multicast" | "unicast" | "anycast";

/** One feed row — burst-coalesced and structured (no ansi; the UI colors/lays it out). */
export interface FeedEntry {
  /** Stable React key. */
  id: string;
  ts: number;
  kind: FeedKind;
  from: EndpointRef;
  /** multicast: the channel. */
  channel?: string;
  /** anycast: the target role. */
  toService?: string;
  /** unicast: recipient display names (length = count; >1 ⇒ fan-out burst). */
  toNames?: string[];
  /** Raw messages this row represents (1 unless a unicast burst was coalesced). */
  count: number;
  text: string;
}

export interface MeshStatus {
  connected: boolean;
  space: string;
  agents: number;
  endpoints: number;
  error?: string;
}

export interface MeshState {
  roster: RosterEntry[];
  channels: ChannelInfo[];
  feed: FeedEntry[];
  status: MeshStatus;
  rates: { perSec: number; total: number };
}

// ---- tuning ----------------------------------------------------------------

const FEED_CAP = 500; // windowed firehose
const COALESCE_MS = 400; // unicast fan-out grouping window (matches render.ts)
const FLUSH_MS = 33; // ~30fps cap on React re-renders (matches the TUI's maxFps)
const RATE_WINDOW_MS = 3000; // trailing window for perSec
const TICK_MS = 1000; // keep ageMs / perSec live while idle

const STATUS_ORDER: Record<string, number> = { working: 0, waiting: 1, idle: 2, offline: 3 };

// tap() has no per-call unsubscribe (it's dropped on ep.stop), so install exactly one tap
// per endpoint and route it to whichever store is currently mounted. A dev StrictMode
// remount then can't double-count or deliver into a torn-down store.
const tapInstalled = new WeakSet<CotalEndpoint>();
const liveStore = new Map<CotalEndpoint, MeshStore>();

function bodyOf(msg: CotalMessage): string {
  return msg.parts.map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ");
}

interface Pending {
  firstId: string;
  ts: number;
  from: EndpointRef;
  body: string;
  ids: string[];
  timer: ReturnType<typeof setTimeout>;
}

class MeshStore {
  private live = true;
  private connected = false;
  private error?: string;
  private roster: Presence[] = [];
  private rosterById = new Map<string, Presence>();
  private channels = new Map<string, number>();
  private feed: FeedEntry[] = [];
  private pending = new Map<string, Pending>();
  private rateRing: number[] = [];
  private total = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;

  private readonly onRoster = (r: Presence[]): void => {
    this.roster = r;
    this.rosterById = new Map(r.map((p) => [p.card.id, p]));
    this.schedule();
  };
  private readonly onError = (e: Error): void => {
    this.error = e.message;
    this.schedule();
  };

  constructor(
    private readonly ep: CotalEndpoint,
    private readonly tapSubject: string | undefined,
    private readonly emit: (s: MeshState) => void,
  ) {}

  attach(): void {
    this.ep.on("roster", this.onRoster);
    this.ep.on("error", this.onError);
    // Seed from whatever the already-started endpoint already knows.
    this.onRoster(this.ep.getRoster());
    this.connected = true;

    if (!tapInstalled.has(this.ep)) {
      tapInstalled.add(this.ep);
      this.ep.tap(
        (subject, msg) => liveStore.get(this.ep)?.ingest(subject, msg),
        this.tapSubject ? { subject: this.tapSubject } : undefined,
      );
    }
    liveStore.set(this.ep, this);

    // Channel tabs: seed counts from the backlog, then live traffic increments them.
    void this.ep
      .listChannels()
      .then((list) => {
        for (const { channel, messages } of list)
          this.channels.set(channel, Math.max(this.channels.get(channel) ?? 0, messages));
        this.schedule();
      })
      .catch(() => {
        /* discovery is best-effort */
      });

    this.tick = setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  detach(): void {
    this.live = false;
    this.ep.off("roster", this.onRoster);
    this.ep.off("error", this.onError);
    if (liveStore.get(this.ep) === this) liveStore.delete(this.ep);
    if (this.tick) clearInterval(this.tick);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  // ---- ingestion ----------------------------------------------------------

  private ingest(subject: string, msg: CotalMessage | undefined): void {
    if (!this.live || !msg) return;
    const kind = deliveryOf(subject); // "chat" | "unicast" | "anycast" | null
    if (!kind) return; // control/trace/presence — not a peer message
    this.recordRate();
    if (kind === "unicast") {
      this.coalesce(msg);
    } else {
      if (kind === "chat" && msg.channel)
        this.channels.set(msg.channel, (this.channels.get(msg.channel) ?? 0) + 1);
      this.push({
        id: msg.id,
        ts: msg.ts,
        kind: kind === "chat" ? "multicast" : "anycast",
        from: msg.from,
        channel: msg.channel,
        toService: msg.toService,
        count: 1,
        text: bodyOf(msg),
      });
    }
    this.schedule();
  }

  /** Group same-sender, same-text unicast bursts (a fan-out) into one row. */
  private coalesce(msg: CotalMessage): void {
    const body = bodyOf(msg);
    const key = msg.from.id + " " + body;
    let p = this.pending.get(key);
    if (!p) {
      p = {
        firstId: msg.id,
        ts: msg.ts,
        from: msg.from,
        body,
        ids: [],
        timer: setTimeout(() => this.flushPending(key), COALESCE_MS),
      };
      this.pending.set(key, p);
    }
    if (msg.to) p.ids.push(msg.to);
  }

  private flushPending(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    this.push({
      id: p.firstId,
      ts: p.ts,
      kind: "unicast",
      from: p.from,
      toNames: p.ids.map((id) => this.nameOf(id)),
      count: Math.max(1, p.ids.length),
      text: p.body,
    });
    this.schedule();
  }

  private push(e: FeedEntry): void {
    this.feed.push(e);
    if (this.feed.length > FEED_CAP) this.feed.shift();
  }

  private recordRate(): void {
    this.rateRing.push(Date.now());
    this.total++;
  }

  private nameOf(id: string): string {
    return this.rosterById.get(id)?.card.name ?? id.slice(0, 8);
  }

  // ---- snapshot -----------------------------------------------------------

  private schedule(): void {
    if (this.flushTimer || !this.live) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.live) this.emit(this.build());
    }, FLUSH_MS);
  }

  private build(): MeshState {
    const now = Date.now();
    const roster: RosterEntry[] = [...this.roster]
      .sort(
        (a, b) =>
          (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
          a.card.name.localeCompare(b.card.name),
      )
      .map((p) => ({ ...p, ageMs: Math.max(0, now - p.ts), isAgent: p.card.kind === "agent" }));

    const channels: ChannelInfo[] = [...this.channels]
      .map(([channel, messages]) => ({ channel, messages }))
      .sort((a, b) => a.channel.localeCompare(b.channel));

    // Trailing-window throughput; prune here so perSec decays to 0 when idle.
    const cutoff = now - RATE_WINDOW_MS;
    while (this.rateRing.length && this.rateRing[0] < cutoff) this.rateRing.shift();
    const perSec = Math.round((this.rateRing.length / RATE_WINDOW_MS) * 1000 * 10) / 10;

    const agents = roster.filter((r) => r.isAgent).length;
    return {
      roster,
      channels,
      feed: this.feed.slice(),
      status: {
        connected: this.connected,
        space: this.ep.space,
        agents,
        endpoints: roster.length - agents,
        error: this.error,
      },
      rates: { perSec, total: this.total },
    };
  }
}

// ---- hook ------------------------------------------------------------------

/**
 * Read-only UI state over an already-started observer endpoint. The owning command
 * constructs + start()s the endpoint (registerPresence:false, consume:false,
 * watchPresence:true) and stop()s it on exit; the hook only subscribes and tears its
 * listeners down on unmount — it never opens a connection or starts/stops the endpoint.
 *
 * `opts.tapSubject`: under auth an observer may only subscribe chat.> (DM/anycast stay
 * confidential) — pass `chatWildcard(space)` there or the space-wildcard tap is denied and
 * the feed dies. Open mode taps the whole space (all three delivery modes) by default.
 */
export function useMesh(ep: CotalEndpoint, opts?: { tapSubject?: string }): MeshState {
  const [state, setState] = useState<MeshState>(() => ({
    roster: [],
    channels: [],
    feed: [],
    status: { connected: false, space: ep.space, agents: 0, endpoints: 0 },
    rates: { perSec: 0, total: 0 },
  }));
  useEffect(() => {
    const store = new MeshStore(ep, opts?.tapSubject, setState);
    store.attach();
    return () => store.detach();
  }, [ep, opts?.tapSubject]);
  return state;
}
