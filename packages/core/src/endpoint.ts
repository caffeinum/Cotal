import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  connect,
  JSONCodec,
  type NatsConnection,
  type Subscription,
  type KV,
  type KvEntry,
} from "nats";

import type {
  AgentCard,
  EndpointRef,
  Part,
  Presence,
  PresenceStatus,
  SwarlMessage,
} from "./types.js";
import {
  chatSubject,
  dmSubject,
  presenceBucket,
  spaceWildcard,
} from "./subjects.js";

export const DEFAULT_SERVER = "nats://127.0.0.1:4222";

export interface EndpointOptions {
  /** The collaboration to join. */
  space: string;
  /** Identity. `id` is generated if omitted. */
  card: Omit<AgentCard, "id"> & { id?: string };
  servers?: string;
  /** Channels to subscribe to; the first is the default broadcast target. */
  channels?: string[];
  /** Presence heartbeat interval (ms). */
  heartbeatMs?: number;
  /** Presence liveness window (ms); a peer is considered gone after this. */
  ttlMs?: number;
  /** Publish our own presence (default true). */
  registerPresence?: boolean;
  /** Track the roster of peers (default true). */
  watchPresence?: boolean;
}

/** Events: "message" (SwarlMessage), "presence" (PresenceEvent), "roster" (Presence[]), "error" (Error). */
export class SwarlEndpoint extends EventEmitter {
  readonly card: AgentCard;
  readonly space: string;
  readonly channels: string[];

  private readonly servers: string;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly doRegister: boolean;
  private readonly doWatch: boolean;

  private nc?: NatsConnection;
  private kv?: KV;
  private readonly subs: Subscription[] = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly roster = new Map<string, Presence>();
  private status: PresenceStatus = "idle";
  private activity?: string;
  private stopped = false;

  private readonly codec = JSONCodec();

  constructor(opts: EndpointOptions) {
    super();
    this.space = opts.space;
    const id = opts.card.id ?? randomUUID();
    this.card = { ...opts.card, id };
    this.servers = opts.servers ?? DEFAULT_SERVER;
    this.channels = opts.channels ?? ["general"];
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
    this.ttlMs = opts.ttlMs ?? 6000;
    this.doRegister = opts.registerPresence ?? true;
    this.doWatch = opts.watchPresence ?? true;
  }

  ref(): EndpointRef {
    return { id: this.card.id, name: this.card.name, role: this.card.role };
  }

  async start(): Promise<void> {
    this.nc = await connect({
      servers: this.servers,
      name: `swarl:${this.card.name}`,
    });

    const js = this.nc.jetstream();
    this.kv = await js.views.kv(presenceBucket(this.space), { ttl: this.ttlMs });

    if (this.doWatch) {
      await this.startPresenceWatch();
      this.sweepTimer = setInterval(
        () => this.sweep(),
        Math.max(500, Math.floor(this.ttlMs / 3)),
      );
    }

    if (this.doRegister) {
      await this.publishPresence();
      this.heartbeatTimer = setInterval(() => {
        this.publishPresence().catch((e) => this.emit("error", e as Error));
      }, this.heartbeatMs);
    }

    for (const ch of this.channels) this.subscribe(chatSubject(this.space, ch));
    this.subscribe(dmSubject(this.space, this.card.id));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    try {
      if (this.doRegister) {
        this.status = "offline";
        await this.publishPresence();
      }
    } catch {
      /* best-effort graceful leave */
    }
    try {
      await this.nc?.drain();
    } catch {
      /* ignore */
    }
  }

  // ---- messaging -----------------------------------------------------------

  async broadcast(
    text: string,
    opts?: { channel?: string; parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<SwarlMessage> {
    const channel = opts?.channel ?? this.channels[0] ?? "general";
    const msg: SwarlMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      channel,
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    this.nc?.publish(chatSubject(this.space, channel), this.codec.encode(msg));
    return msg;
  }

  async dm(
    peerId: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<SwarlMessage> {
    const msg: SwarlMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      to: peerId,
      channel: "dm",
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    this.nc?.publish(dmSubject(this.space, peerId), this.codec.encode(msg));
    return msg;
  }

  /** Subscribe to every subject in the space (read-only observer). */
  tap(handler: (subject: string, msg: SwarlMessage | undefined) => void): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(spaceWildcard(this.space));
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        let decoded: SwarlMessage | undefined;
        try {
          decoded = this.codec.decode(m.data) as SwarlMessage;
        } catch {
          decoded = undefined;
        }
        handler(m.subject, decoded);
      }
    })().catch((e) => this.emit("error", e as Error));
  }

  // ---- presence ------------------------------------------------------------

  getRoster(): Presence[] {
    return [...this.roster.values()].sort((a, b) =>
      a.card.name.localeCompare(b.card.name),
    );
  }

  async setActivity(activity: string): Promise<void> {
    this.activity = activity;
    await this.publishPresence();
  }

  async setStatus(status: PresenceStatus): Promise<void> {
    this.status = status;
    await this.publishPresence();
  }

  // ---- internals -----------------------------------------------------------

  private subscribe(subject: string): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(subject);
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        try {
          const msg = this.codec.decode(m.data) as SwarlMessage;
          if (msg.from?.id === this.card.id) continue; // ignore our own echo
          this.emit("message", msg);
        } catch (e) {
          this.emit("error", e as Error);
        }
      }
    })().catch((e) => this.emit("error", e as Error));
  }

  private async publishPresence(): Promise<void> {
    if (!this.kv) return;
    const p: Presence = {
      card: this.card,
      status: this.status,
      activity: this.activity,
      ts: Date.now(),
    };
    await this.kv.put(this.card.id, this.codec.encode(p));
  }

  private async startPresenceWatch(): Promise<void> {
    if (!this.kv) return;
    const iter = await this.kv.watch();
    void (async () => {
      for await (const e of iter) this.handleKvEntry(e);
    })().catch((e) => this.emit("error", e as Error));
  }

  private handleKvEntry(e: KvEntry): void {
    if (e.operation === "DEL" || e.operation === "PURGE") {
      this.markOffline(e.key);
      return;
    }
    let p: Presence;
    try {
      p = this.codec.decode(e.value) as Presence;
    } catch {
      return;
    }
    this.applyPresence(e.key, p);
  }

  private applyPresence(id: string, raw: Presence): void {
    const prev = this.roster.get(id);
    const stale = Date.now() - raw.ts > this.ttlMs;
    const p: Presence =
      stale && raw.status !== "offline" ? { ...raw, status: "offline" } : raw;

    // First time we hear about an already-offline peer (stale snapshot): record quietly.
    if (!prev && p.status === "offline") {
      this.roster.set(id, p);
      this.emit("roster", this.getRoster());
      return;
    }

    this.roster.set(id, p);
    const type: "join" | "update" | "offline" =
      p.status === "offline"
        ? "offline"
        : !prev || prev.status === "offline"
          ? "join"
          : "update";
    this.emit("presence", { type, presence: p });
    this.emit("roster", this.getRoster());
  }

  /** Mark a known peer offline (on KV delete/purge), keeping it in the roster. */
  private markOffline(id: string): void {
    const prev = this.roster.get(id);
    if (!prev || prev.status === "offline") return;
    const offline: Presence = { ...prev, status: "offline" };
    this.roster.set(id, offline);
    this.emit("presence", { type: "offline", presence: offline });
    this.emit("roster", this.getRoster());
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [, p] of this.roster) {
      if (p.status !== "offline" && now - p.ts > this.ttlMs) {
        p.status = "offline";
        this.emit("presence", { type: "offline", presence: p });
        changed = true;
      }
    }
    if (changed) this.emit("roster", this.getRoster());
  }
}

/** Quick check whether a NATS server is accepting connections. */
export async function isReachable(
  servers: string = DEFAULT_SERVER,
  timeoutMs = 1000,
): Promise<boolean> {
  try {
    const nc = await connect({
      servers,
      timeout: timeoutMs,
      reconnect: false,
      maxReconnectAttempts: 0,
    });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}
