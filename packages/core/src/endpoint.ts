import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  connect,
  JSONCodec,
  nanos,
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type NatsConnection,
  type Subscription,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerMessages,
  type KV,
  type KvEntry,
} from "nats";

import type {
  AgentCard,
  ControlReply,
  ControlRequest,
  Delivery,
  EndpointRef,
  Part,
  Presence,
  PresenceStatus,
  SwarlMessage,
} from "./types.js";
import {
  anycastSubject,
  chatStream,
  chatDurable,
  chatSubject,
  controlServiceSubject,
  dmStream,
  dmDurable,
  presenceBucket,
  spacePrefix,
  spaceWildcard,
  taskStream,
  taskDurable,
  unicastSubject,
} from "./subjects.js";

export const DEFAULT_SERVER = "nats://127.0.0.1:4222";

export interface EndpointOptions {
  /** The collaboration to join. */
  space: string;
  /** Identity. `id` is generated if omitted. */
  card: Omit<AgentCard, "id"> & { id?: string };
  servers?: string;
  /** Connection token (soft-shared auth). Mutually exclusive with user/pass. */
  token?: string;
  /** Username/password auth (both required together). */
  user?: string;
  pass?: string;
  /** Require a TLS connection to the server. */
  tls?: boolean;
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
  /** Create inbound stream consumers (DM / chat / anycast). Default true; a pure observer sets false. */
  consume?: boolean;
  /** How long an unacked (un-surfaced) message waits before redelivery (ms). */
  ackWaitMs?: number;
  /** Retire this instance's durable consumers after it's been gone this long (ms). */
  inactiveThresholdMs?: number;
}

/** Events: "message" (SwarlMessage), "presence" (PresenceEvent), "roster" (Presence[]), "error" (Error). */
export class SwarlEndpoint extends EventEmitter {
  readonly card: AgentCard;
  readonly space: string;
  readonly channels: string[];

  private readonly servers: string;
  private readonly token?: string;
  private readonly user?: string;
  private readonly pass?: string;
  private readonly tls: boolean;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly doRegister: boolean;
  private readonly doWatch: boolean;
  private readonly doConsume: boolean;
  private readonly ackWaitMs: number;
  private readonly inactiveThresholdMs: number;

  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private kv?: KV;
  private readonly subs: Subscription[] = [];
  private readonly streamMsgs: ConsumerMessages[] = [];
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
    this.token = opts.token;
    this.user = opts.user;
    this.pass = opts.pass;
    this.tls = opts.tls ?? false;
    this.channels = opts.channels ?? ["general"];
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
    this.ttlMs = opts.ttlMs ?? 6000;
    this.doRegister = opts.registerPresence ?? true;
    this.doWatch = opts.watchPresence ?? true;
    this.doConsume = opts.consume ?? true;
    this.ackWaitMs = opts.ackWaitMs ?? 60_000;
    this.inactiveThresholdMs = opts.inactiveThresholdMs ?? 600_000;
  }

  ref(): EndpointRef {
    return { id: this.card.id, name: this.card.name, role: this.card.role };
  }

  async start(): Promise<void> {
    this.nc = await connect({
      servers: this.servers,
      name: `swarl:${this.card.name}`,
      ...authOpts({ token: this.token, user: this.user, pass: this.pass, tls: this.tls }),
    });
    this.js = this.nc.jetstream();

    if (this.doWatch || this.doRegister) {
      this.kv = await this.js.views.kv(presenceBucket(this.space), { ttl: this.ttlMs });
    }

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

    if (this.doConsume) {
      this.jsm = await this.nc.jetstreamManager();
      await this.ensureStreams();
      await this.startConsumers();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const msgs of this.streamMsgs) {
      try {
        msgs.stop();
      } catch {
        /* already closed */
      }
    }
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

  /** Multicast: broadcast to everyone on a channel. */
  async multicast(
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
    await this.publishMsg(chatSubject(this.space, channel), msg);
    return msg;
  }

  /** Unicast: direct message to one specific instance. */
  async unicast(
    instanceId: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<SwarlMessage> {
    const msg: SwarlMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      to: instanceId,
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    await this.publishMsg(unicastSubject(this.space, instanceId), msg);
    return msg;
  }

  /** Anycast: deliver to ANY one instance of a service (role) — queue-group load balancing. */
  async anycast(
    service: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<SwarlMessage> {
    const msg: SwarlMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      toService: service,
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    await this.publishMsg(anycastSubject(this.space, service), msg);
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

  // ---- control plane (request/reply) --------------------------------------

  /** Serve control requests for a service (manager side). */
  serveControl(
    service: string,
    handler: (req: ControlRequest) => Promise<ControlReply> | ControlReply,
  ): void {
    if (!this.nc) throw new Error("endpoint not started");
    const sub = this.nc.subscribe(controlServiceSubject(this.space, service), {
      queue: service,
    });
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        let reply: ControlReply;
        try {
          reply = await handler(this.codec.decode(m.data) as ControlRequest);
        } catch (e) {
          reply = { ok: false, error: (e as Error).message };
        }
        try {
          m.respond(this.codec.encode(reply));
        } catch {
          /* no reply inbox */
        }
      }
    })().catch((e) => this.emit("error", e as Error));
  }

  /** Send a control request to a service and await its reply (client side). */
  async requestControl(
    service: string,
    req: ControlRequest,
    timeoutMs = 5000,
  ): Promise<ControlReply> {
    if (!this.nc) throw new Error("endpoint not started");
    const m = await this.nc.request(
      controlServiceSubject(this.space, service),
      this.codec.encode({ ...req, from: req.from ?? this.ref() }),
      { timeout: timeoutMs },
    );
    return this.codec.decode(m.data) as ControlReply;
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

  private async publishMsg(subject: string, msg: SwarlMessage): Promise<void> {
    if (!this.js) throw new Error("endpoint not started");
    // msgID = message id → free server-side dedup across JetStream redelivery.
    await this.js.publish(subject, this.codec.encode(msg), { msgID: msg.id });
  }

  /** Create the three backing streams for this space (idempotent). */
  private async ensureStreams(): Promise<void> {
    if (!this.jsm) throw new Error("endpoint not started");
    const p = spacePrefix(this.space);
    await this.jsm.streams.add({
      name: chatStream(this.space),
      subjects: [`${p}.chat.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_msgs_per_subject: 1000, // capped per-channel backlog (buffer + history)
      discard: DiscardPolicy.Old,
    });
    await this.jsm.streams.add({
      name: dmStream(this.space),
      subjects: [`${p}.inst.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
    });
    await this.jsm.streams.add({
      name: taskStream(this.space),
      subjects: [`${p}.svc.>`],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
    });
  }

  /** Bind this endpoint's durable consumers: DM inbox, chat, and (if a role) the task queue. */
  private async startConsumers(): Promise<void> {
    if (!this.jsm) throw new Error("endpoint not started");
    const id = this.card.id;
    const ack_wait = nanos(this.ackWaitMs);
    const inactive_threshold = nanos(this.inactiveThresholdMs);

    // Unicast: this instance's private DM inbox.
    await this.jsm.consumers.add(dmStream(this.space), {
      durable_name: dmDurable(id),
      filter_subject: unicastSubject(this.space, id),
      ack_policy: AckPolicy.Explicit,
      ack_wait,
      deliver_policy: DeliverPolicy.All,
      inactive_threshold,
    });
    await this.pump(dmStream(this.space), dmDurable(id));

    // Multicast: every message on our channels, at our own pace (replays the retained window).
    if (this.channels.length) {
      await this.jsm.consumers.add(chatStream(this.space), {
        durable_name: chatDurable(id),
        filter_subjects: this.channels.map((ch) => chatSubject(this.space, ch)),
        ack_policy: AckPolicy.Explicit,
        ack_wait,
        deliver_policy: DeliverPolicy.All,
        inactive_threshold,
      });
      await this.pump(chatStream(this.space), chatDurable(id));
    }

    // Anycast: a shared work-queue consumer for our role — one instance grabs each task.
    if (this.card.role) {
      await this.jsm.consumers.add(taskStream(this.space), {
        durable_name: taskDurable(this.card.role),
        filter_subject: anycastSubject(this.space, this.card.role),
        ack_policy: AckPolicy.Explicit,
        ack_wait,
      });
      await this.pump(taskStream(this.space), taskDurable(this.card.role));
    }
  }

  /** Drive one consumer: decode, drop our own echo, and hand each message to listeners with ack control. */
  private async pump(stream: string, durable: string): Promise<void> {
    if (!this.js) throw new Error("endpoint not started");
    const consumer = await this.js.consumers.get(stream, durable);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    void (async () => {
      for await (const m of msgs) {
        let msg: SwarlMessage;
        try {
          msg = this.codec.decode(m.data) as SwarlMessage;
        } catch (e) {
          m.term(); // undecodable — never redeliver
          this.emit("error", e as Error);
          continue;
        }
        if (msg.from?.id === this.card.id) {
          m.ack(); // our own echo — advance past it
          continue;
        }
        const delivery: Delivery = { ack: () => m.ack(), nak: () => m.nak() };
        this.emit("message", msg, delivery);
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
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

    // Heartbeat refresh with no real change: bump liveness quietly and don't
    // emit — otherwise the periodic keep-alive looks like a stream of "updates".
    if (
      prev &&
      prev.status !== "offline" &&
      p.status !== "offline" &&
      prev.status === p.status &&
      prev.activity === p.activity
    ) {
      this.roster.set(id, p);
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

/** Auth subset of connect() options, shared by the endpoint and isReachable. */
interface AuthOpts {
  token?: string;
  user?: string;
  pass?: string;
  tls?: boolean;
}

function authOpts(a: AuthOpts) {
  return { token: a.token, user: a.user, pass: a.pass, tls: a.tls ? {} : undefined };
}

/** Quick check whether a NATS server is accepting (authenticated) connections. */
export async function isReachable(
  servers: string = DEFAULT_SERVER,
  opts: AuthOpts & { timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const nc = await connect({
      servers,
      timeout: opts.timeoutMs ?? 1000,
      reconnect: false,
      maxReconnectAttempts: 0,
      ...authOpts(opts),
    });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}
