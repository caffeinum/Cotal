import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  connect,
  credsAuthenticator,
  nanos,
  PermissionViolationError,
  type NatsConnection,
  type Subscription,
} from "@nats-io/transport-node";
import { idFromCreds } from "./identity.js";
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerMessages,
} from "@nats-io/jetstream";
import { Kvm, type KV, type KvEntry } from "@nats-io/kv";

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
  collapseFilterSubjects,
  controlServiceSubject,
  dmStream,
  dmDurable,
  isConcreteChannel,
  parseSubject,
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
  /** NATS user creds file *content* (JWT + nkey seed). When set, the endpoint
   *  authenticates as that user and adopts the creds' identity as its card.id. */
  creds?: string;
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

/**
 * Events: "message" (SwarlMessage), "presence" (PresenceEvent), "roster" (Presence[]), "error" (Error).
 *
 * Callers MUST attach an "error" listener before `start()`: async faults (incl. NATS
 * permission denials, surfaced via `watchStatus`) are emitted as "error", and Node throws
 * synchronously on an unhandled "error" — a missing listener turns any such fault into a
 * process crash instead of a logged denial.
 */
export class SwarlEndpoint extends EventEmitter {
  readonly card: AgentCard;
  readonly space: string;
  readonly channels: string[];

  private readonly servers: string;
  private readonly token?: string;
  private readonly user?: string;
  private readonly pass?: string;
  private readonly creds?: string;
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


  constructor(opts: EndpointOptions) {
    super();
    this.space = opts.space;
    // Identity precedence: an explicit card.id, else the creds' identity, else a random
    // uuid. When both an id and creds are given they MUST name the same nkey — otherwise
    // the subject sender token wouldn't match the authenticated user and every publish
    // would be denied (a silent-failure class).
    const credId = opts.creds ? idFromCreds(opts.creds) : undefined;
    if (opts.card.id && credId && opts.card.id !== credId)
      throw new Error(`card.id ${opts.card.id} != creds identity ${credId} — they must be the same nkey`);
    const id = opts.card.id ?? credId ?? randomUUID();
    this.card = { ...opts.card, id };
    this.servers = opts.servers ?? DEFAULT_SERVER;
    this.token = opts.token;
    this.user = opts.user;
    this.pass = opts.pass;
    this.creds = opts.creds;
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
      // Per-identity inbox namespace (the "Private Inbox" pattern). nats.js routes ALL
      // generated inboxes — request replies, JetStream pull delivery, kv.watch ordered-
      // consumer delivery — through this prefix. Paired with sub.allow=[_INBOX_<id>.>]
      // (auth mode) it stops a peer from subscribing the wildcard inbox to sniff others'
      // DM deliveries. Set unconditionally so the prefix can never drift from the ACL.
      inboxPrefix: `_INBOX_${this.card.id}`,
      ...authOpts({ token: this.token, user: this.user, pass: this.pass, creds: this.creds, tls: this.tls }),
    });
    this.watchStatus();
    this.js = jetstream(this.nc);

    if (this.doWatch || this.doRegister) {
      this.kv = await new Kvm(this.nc).create(presenceBucket(this.space), { ttl: this.ttlMs });
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
      this.jsm = await jetstreamManager(this.nc);
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
    // Publish must target a concrete sub-channel — you can't broadcast to a
    // wildcard. Default to the first concrete channel we're on (channels[0] may
    // itself be a wildcard subscription like `team.>`).
    const channel = opts?.channel ?? this.channels.find(isConcreteChannel) ?? "general";
    if (!isConcreteChannel(channel))
      throw new Error(`cannot publish to wildcard channel "${channel}" — pick a concrete sub-channel`);
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
    await this.publishMsg(chatSubject(this.space, this.card.id, channel), msg);
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
    await this.publishMsg(unicastSubject(this.space, instanceId, this.card.id), msg);
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
    await this.publishMsg(anycastSubject(this.space, service, this.card.id), msg);
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
          decoded = m.json<SwarlMessage>();
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
    const sub = this.nc.subscribe(controlServiceSubject(this.space, service, "*"), {
      queue: service,
    });
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        let reply: ControlReply;
        try {
          reply = await handler(m.json<ControlRequest>());
        } catch (e) {
          reply = { ok: false, error: (e as Error).message };
        }
        try {
          m.respond(JSON.stringify(reply));
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
      controlServiceSubject(this.space, service, this.card.id),
      JSON.stringify({ ...req, from: req.from ?? this.ref() }),
      { timeout: timeoutMs },
    );
    return m.json<ControlReply>();
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

  // ---- channel discovery ---------------------------------------------------

  /** List channels that have messages in the chat stream, with message counts.
   *  Works even on observer endpoints (no consumers needed). */
  async listChannels(): Promise<{ channel: string; messages: number }[]> {
    if (!this.nc) throw new Error("endpoint not started");
    const mgr = await jetstreamManager(this.nc);
    let info;
    try {
      info = await mgr.streams.info(chatStream(this.space), { subjects_filter: ">" });
    } catch {
      return [];
    }
    // Subjects now carry the sender (chat.<sender>.<channel>), so collapse across senders:
    // sum each channel's counts regardless of who published.
    const counts = new Map<string, number>();
    if (info.state.subjects) {
      for (const [subject, count] of Object.entries(info.state.subjects)) {
        const p = parseSubject(subject);
        if (p?.kind === "chat") counts.set(p.rest, (counts.get(p.rest) ?? 0) + count);
      }
    }
    return [...counts]
      .map(([channel, messages]) => ({ channel, messages }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }

  /** Fetch recent messages from a channel's JetStream backlog. */
  async channelHistory(
    channel: string,
    opts?: { limit?: number },
  ): Promise<SwarlMessage[]> {
    if (!this.nc) throw new Error("endpoint not started");
    const js = jetstream(this.nc);
    const subject = chatSubject(this.space, "*", channel); // history from any sender
    const limit = opts?.limit ?? 100;
    const msgs: SwarlMessage[] = [];
    try {
      const consumer = await js.consumers.get(chatStream(this.space), {
        filter_subjects: [subject],
      });
      const iter = await consumer.fetch({ max_messages: limit });
      for await (const m of iter) {
        try {
          msgs.push(m.json<SwarlMessage>());
        } catch {
          /* skip undecodable */
        }
      }
    } catch {
      /* stream or consumer may not exist yet */
    }
    return msgs;
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Surface the connection's async status errors on our `error` event. NATS reports
   * publish permission violations *only* here (subscription/request ones too), never on
   * the failing call — so without this an over-tight ACL silently drops the agent's
   * traffic and it just looks "absent". We annotate permission denials explicitly so a
   * denial is never mistaken for absence (which already has a benign cause: MCP reconnect).
   */
  private watchStatus(): void {
    if (!this.nc) return;
    void (async () => {
      for await (const s of this.nc!.status()) {
        if (s.type === "error") this.emit("error", describeStatusError(s.error));
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  private async publishMsg(subject: string, msg: SwarlMessage): Promise<void> {
    if (!this.js) throw new Error("endpoint not started");
    // msgID = message id → free server-side dedup across JetStream redelivery.
    await this.js.publish(subject, JSON.stringify(msg), { msgID: msg.id });
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
      filter_subject: unicastSubject(this.space, id, "*"), // DMs to me, from any sender
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
        // Wildcard channels (team.>) may subsume concrete ones (team.backend);
        // JetStream rejects overlapping filter_subjects, so collapse first.
        filter_subjects: collapseFilterSubjects(this.channels.map((ch) => chatSubject(this.space, "*", ch))),
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
        filter_subject: anycastSubject(this.space, this.card.role, "*"), // tasks for my role, any sender
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
          msg = m.json<SwarlMessage>();
        } catch (e) {
          m.term(); // undecodable — never redeliver
          this.emit("error", e as Error);
          continue;
        }
        // Authenticity guard (fail closed): the sender is encoded in the subject, which the
        // server policed who could publish. The payload `from` is advisory — it must match,
        // and a missing `from` or an unparseable subject on a delivery is itself an anomaly.
        // Reject (term — a spoof is permanently invalid, never redeliver) BEFORE any handler.
        const parsed = parseSubject(m.subject);
        if (!parsed || !msg.from || msg.from.id !== parsed.sender) {
          m.term();
          this.emit(
            "error",
            new Error(
              `dropped message on ${m.subject}: payload from ${msg.from?.id ?? "(none)"} ` +
                `does not match subject sender ${parsed?.sender ?? "(unparseable)"}`,
            ),
          );
          continue;
        }
        if (msg.from.id === this.card.id) {
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
    await this.kv.put(this.card.id, JSON.stringify(p));
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
      p = e.json<Presence>();
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
  creds?: string;
  tls?: boolean;
}

function authOpts(a: AuthOpts) {
  const tls = a.tls ? {} : undefined;
  // creds (JWT/nkey) are mutually exclusive with token/user/pass — reject rather than
  // silently pick one, so a misconfigured caller fails loud.
  if (a.creds) {
    if (a.token || a.user || a.pass)
      throw new Error("creds are mutually exclusive with token/user/pass auth");
    return { authenticator: credsAuthenticator(new TextEncoder().encode(a.creds)), tls };
  }
  return { token: a.token, user: a.user, pass: a.pass, tls };
}

/** Turn a raw async-status error into one whose message says *why* — a permission
 *  violation looks like absence unless it's named as a denial. */
function describeStatusError(err: Error): Error {
  if (err instanceof PermissionViolationError) {
    return new Error(
      `NATS permission denied: cannot ${err.operation} "${err.subject}" — check this ` +
        `endpoint's ACLs (a denied peer looks "absent" rather than blocked)`,
      { cause: err },
    );
  }
  return err;
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
