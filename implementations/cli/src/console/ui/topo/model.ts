// The topology model behind the `t` lens — a pure fold of the mesh snapshot
// (feed + roster) into a who-talks-to-whom graph. Shared by all three variants
// (sequence / matrix / map); render-agnostic and stateless — `now` is injectable,
// so the fold is deterministic and the recency kernel needs no stored EWMA state.

import type { Presence, PresenceStatus } from "@cotal/core";
import type { FeedDelivery, FeedEntry } from "../../mesh.js";

export type TopoNodeKind = "agent" | "channel" | "service";

export interface TopoNode {
  /** Kind-prefixed name: "a:alice" | "c:general" | "s:planner". */
  key: string;
  kind: TopoNodeKind;
  /** Display name — renderers add the #/@ prefix. */
  name: string;
  status?: PresenceStatus; // agents only
  role?: string;
  /** Last involvement inside the window (0 = present but silent). */
  lastTs: number;
}

export interface TopoEdge {
  key: string; // src + "→" + dst
  src: string; // TopoNode.key
  dst: string;
  mode: FeedDelivery;
  count: number; // messages inside the window
  lastTs: number;
  /** Recency intensity: Σ exp(-(now-ts)/τ), τ = 20s — a stateless EWMA. */
  rate: number;
}

export interface TopoGraph {
  /** Agents (roster order) first, then channels, then services (each alphabetical). */
  nodes: TopoNode[];
  /** Ascending by rate — renderers overdraw hot edges last. */
  edges: TopoEdge[];
  byKey: Map<string, TopoNode>;
  windowMs: number;
  now: number;
}

const RATE_TAU_MS = 20_000;
export const DEFAULT_TOPO_WINDOW_MS = 120_000;

/** The target node(s) a feed entry talks to — the single place delivery → node mapping lives. */
export function targetsOf(e: FeedEntry): { key: string; kind: TopoNodeKind; name: string }[] {
  if (e.delivery === "multicast") {
    const name = e.channel ?? "?";
    return [{ key: "c:" + name, kind: "channel", name }];
  }
  if (e.delivery === "anycast") {
    const name = e.toService ?? "?";
    return [{ key: "s:" + name, kind: "service", name }];
  }
  if (e.delivery === "unicast")
    return (e.toNames ?? []).map((name) => ({ key: "a:" + name, kind: "agent" as const, name }));
  throw new Error(`foldTopo: unknown delivery "${(e as { delivery: string }).delivery}"`);
}

export function foldTopo(
  feed: FeedEntry[],
  agents: Presence[],
  opts?: { windowMs?: number; now?: number },
): TopoGraph {
  const now = opts?.now ?? Date.now();
  const windowMs = opts?.windowMs ?? DEFAULT_TOPO_WINDOW_MS;

  const byKey = new Map<string, TopoNode>();
  // Roster agents stay visible even when silent — silence is itself a signal.
  for (const p of agents) {
    const key = "a:" + p.card.name;
    if (!byKey.has(key))
      byKey.set(key, {
        key,
        kind: "agent",
        name: p.card.name,
        status: p.status,
        role: p.card.role,
        lastTs: 0,
      });
  }
  // A node first seen in traffic (sender gone from the roster, channel, service).
  const touch = (key: string, kind: TopoNodeKind, name: string, ts: number): TopoNode => {
    let n = byKey.get(key);
    if (!n) {
      n = { key, kind, name, lastTs: 0, ...(kind === "agent" ? { status: "offline" as const } : {}) };
      byKey.set(key, n);
    }
    if (ts > n.lastTs) n.lastTs = ts;
    return n;
  };

  const edges = new Map<string, TopoEdge>();
  for (const e of feed) {
    if (e.ts < now - windowMs) continue;
    const src = touch("a:" + e.from.name, "agent", e.from.name, e.ts);
    if (e.from.role && !src.role) src.role = e.from.role;
    const mult = e.count ?? 1; // coalesced unicast burst multiplicity
    const w = Math.exp(-(now - e.ts) / RATE_TAU_MS) * mult;
    for (const t of targetsOf(e)) {
      const dst = touch(t.key, t.kind, t.name, e.ts);
      const key = src.key + "→" + dst.key;
      let edge = edges.get(key);
      if (!edge) {
        edge = { key, src: src.key, dst: dst.key, mode: e.delivery, count: 0, lastTs: 0, rate: 0 };
        edges.set(key, edge);
      }
      edge.count += mult;
      edge.lastTs = Math.max(edge.lastTs, e.ts);
      edge.rate += w;
    }
  }

  // Agents keep roster order (traffic-only senders appended by name); hubs alphabetical.
  const rosterOrder = new Map(agents.map((p, i) => ["a:" + p.card.name, i]));
  const all = [...byKey.values()];
  const agentNodes = all
    .filter((n) => n.kind === "agent")
    .sort((a, b) => {
      const ai = rosterOrder.get(a.key) ?? Infinity;
      const bi = rosterOrder.get(b.key) ?? Infinity;
      return ai - bi || a.name.localeCompare(b.name);
    });
  const hub = (kind: TopoNodeKind) =>
    all.filter((n) => n.kind === kind).sort((a, b) => a.name.localeCompare(b.name));

  return {
    nodes: [...agentNodes, ...hub("channel"), ...hub("service")],
    edges: [...edges.values()].sort((a, b) => a.rate - b.rate),
    byKey,
    windowMs,
    now,
  };
}

// Heat shading shared by the matrix and map: rate → 5 intensity steps.
export const HEAT = [" ", "░", "▒", "▓", "█"] as const;

export function heatLevel(rate: number): 0 | 1 | 2 | 3 | 4 {
  if (rate < 0.05) return 0;
  if (rate < 0.5) return 1;
  if (rate < 2) return 2;
  if (rate < 5) return 3;
  return 4;
}

/** Display label for a node — the renderers' single prefix rule. */
export function nodeLabel(n: TopoNode): string {
  return n.kind === "channel" ? "#" + n.name : n.kind === "service" ? "@" + n.name : n.name;
}

/** The feed entries that flow over one edge, oldest-first (for inspectors/detail). */
export function edgeEntries(feed: FeedEntry[], edge: TopoEdge, graph: TopoGraph): FeedEntry[] {
  return feed.filter(
    (e) =>
      e.ts >= graph.now - graph.windowMs &&
      "a:" + e.from.name === edge.src &&
      targetsOf(e).some((t) => t.key === edge.dst),
  );
}
