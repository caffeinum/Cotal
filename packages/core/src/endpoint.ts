import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  connect,
  credsAuthenticator,
  nanos,
  AuthorizationError,
  PermissionViolationError,
  UserAuthenticationExpiredError,
  type NatsConnection,
  type Subscription,
} from "@nats-io/transport-node";
import { idFromCreds } from "./identity.js";
import { createSpaceStreams, dmDurableConfig, taskDurableConfig } from "./streams.js";
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerMessages,
} from "@nats-io/jetstream";
import { Kvm, type KV, type KvEntry } from "@nats-io/kv";

import type {
  AgentCard,
  ChannelConfig,
  ChannelDefaults,
  ControlReply,
  ControlRequest,
  Delivery,
  EndpointRef,
  Part,
  Presence,
  PresenceStatus,
  CotalMessage,
} from "./types.js";
import { openChannelRegistry, effectiveReplay } from "./channels.js";
import {
  anycastSubject,
  CHANNEL_DEFAULTS_KEY,
  chatStream,
  chatDurable,
  chatSubject,
  collapseFilterSubjects,
  controlServiceSubject,
  dmStream,
  dmDurable,
  isConcreteChannel,
  normalizeMentions,
  parseSubject,
  presenceBucket,
  spacePrefix,
  spaceWildcard,
  subjectMatches,
  taskStream,
  taskDurable,
  token,
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

/** A peer subscribed to a channel — broker truth (a chat-stream consumer) joined with
 *  presence for liveness. `live: false` is a stale ghost: the durable lingers (reconnect
 *  grace) but presence says the peer is gone/offline. */
export interface ChannelMember {
  id: string;
  name: string;
  role?: string;
  live: boolean;
}

/**
 * Events: "message" (CotalMessage), "presence" (PresenceEvent), "roster" (Presence[]), "error" (Error).
 *
 * Callers MUST attach an "error" listener before `start()`: async faults (incl. NATS
 * permission denials, surfaced via `watchStatus`) are emitted as "error", and Node throws
 * synchronously on an unhandled "error" — a missing listener turns any such fault into a
 * process crash instead of a logged denial.
 */
export class CotalEndpoint extends EventEmitter {
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
  private channelKv?: KV;
  /** Live local cache of the channel registry (key = channel token), kept by a KV watch. */
  private readonly channelConfigs = new Map<string, ChannelConfig>();
  private channelDefaults: ChannelDefaults = {};
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
      name: `cotal:${this.card.name}`,
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
      const kvm = new Kvm(this.nc);
      // The presence bucket is a JetStream stream. Open mode lazily creates it; auth mode
      // OPENs it (it's pre-created at `cotal up`; KV stream-create is denied to agents).
      this.kv = this.creds
        ? await kvm.open(presenceBucket(this.space))
        : await kvm.create(presenceBucket(this.space), { ttl: this.ttlMs });
    }

    if (this.doWatch) {
      await this.startPresenceWatch();
      this.sweepTimer = setInterval(
        () => this.sweep(),
        Math.max(500, Math.floor(this.ttlMs / 3)),
      );
      // The channel registry is shared mesh state like presence — open its bucket (auth mode
      // OPENs the pre-created one; open mode lazily creates it) and keep a live local cache.
      this.channelKv = await openChannelRegistry(this.nc, this.space, { create: !this.creds });
      await this.startChannelWatch();
    }

    if (this.doRegister) {
      await this.publishPresence();
      this.heartbeatTimer = setInterval(() => {
        this.publishPresence().catch((e) => this.emit("error", e as Error));
      }, this.heartbeatMs);
    }

    if (this.doConsume) {
      this.jsm = await jetstreamManager(this.nc);
      // Open mode: lazily create the streams on the first endpoint. Auth mode: they are
      // pre-created at `cotal up` and STREAM.CREATE is denied to agents, so skip.
      if (!this.creds) await this.ensureStreams();
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
    opts?: { channel?: string; parts?: Part[]; replyTo?: string; contextId?: string; mentions?: string[] },
  ): Promise<CotalMessage> {
    // Publish must target a concrete sub-channel — you can't broadcast to a
    // wildcard. Default to the first concrete channel we're on (channels[0] may
    // itself be a wildcard subscription like `team.>`).
    const channel = opts?.channel ?? this.channels.find(isConcreteChannel) ?? "general";
    if (!isConcreteChannel(channel))
      throw new Error(`cannot publish to wildcard channel "${channel}" — pick a concrete sub-channel`);
    const msg: CotalMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      channel,
      // Priority/wake hint, not routing — validation (against the roster) is the connector's
      // job; core just canonicalizes and omits the field when empty.
      mentions: normalizeMentions(opts?.mentions),
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
  ): Promise<CotalMessage> {
    const msg: CotalMessage = {
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
  ): Promise<CotalMessage> {
    const msg: CotalMessage = {
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

  /** Subscribe to a read-only observer feed. Defaults to the whole space; an observer under
   *  auth must pass `chatWildcard(space)` since its `sub.allow` only covers chat (DM/anycast
   *  stay confidential), otherwise the space-wildcard subscribe is denied and the feed dies. */
  tap(
    handler: (subject: string, msg: CotalMessage | undefined) => void,
    opts?: { subject?: string },
  ): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(opts?.subject ?? spaceWildcard(this.space));
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        let decoded: CotalMessage | undefined;
        try {
          decoded = m.json<CotalMessage>();
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
          const req = m.json<ControlRequest>();
          // Authenticity guard (fail closed): control is the most privileged surface
          // (start/stop). The sender is encoded in the subject (ctl.<svc>.<sender>), which
          // the server policed who could publish; the payload `from` is advisory and must
          // match. Reject before the handler acts on a request claiming a forged sender.
          const parsed = parseSubject(m.subject);
          if (!parsed || req.from?.id !== parsed.sender) {
            this.emit(
              "error",
              new Error(
                `rejected control request on ${m.subject}: from ${req.from?.id ?? "(none)"} ` +
                  `does not match subject sender ${parsed?.sender ?? "(unparseable)"}`,
              ),
            );
            reply = { ok: false, error: "sender mismatch — request rejected" };
          } else {
            reply = await handler(req);
          }
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

  /** This channel's registry config from the live local cache (undefined if unset). */
  getChannelConfig(channel: string): ChannelConfig | undefined {
    return this.channelConfigs.get(channel);
  }

  /** Effective replay-on-join policy for a channel: per-channel override ?? space default ??
   *  true. Reads the live cache, so it reflects runtime registry edits. */
  channelReplay(channel: string): boolean {
    return effectiveReplay(this.channelConfigs.get(channel), this.channelDefaults);
  }

  /** One coherent channel model for dashboards: every channel that has messages OR a registry
   *  entry (configured-but-empty), each tagged with its {@link ChannelConfig}. Works even on
   *  observer endpoints (no consumers needed). */
  async listChannels(): Promise<{ channel: string; messages: number; config?: ChannelConfig }[]> {
    if (!this.nc) throw new Error("endpoint not started");
    const mgr = await jetstreamManager(this.nc);
    // Subjects carry the sender (chat.<sender>.<channel>), so collapse across senders: sum
    // each channel's counts regardless of who published.
    const counts = new Map<string, number>();
    try {
      const info = await mgr.streams.info(chatStream(this.space), { subjects_filter: ">" });
      if (info.state.subjects) {
        for (const [subject, count] of Object.entries(info.state.subjects)) {
          const p = parseSubject(subject);
          if (p?.kind === "chat") counts.set(p.rest, (counts.get(p.rest) ?? 0) + count);
        }
      }
    } catch {
      /* stream missing — fall through to registry-only channels */
    }
    const channels = new Set<string>([...counts.keys(), ...this.channelConfigs.keys()]);
    return [...channels]
      .map((channel) => ({
        channel,
        messages: counts.get(channel) ?? 0,
        config: this.channelConfigs.get(channel),
      }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }

  /**
   * Who is subscribed to a channel — **broker truth, not self-report**. In Cotal a peer
   * joins a channel by creating a chat-stream durable consumer (`chat_<id>`,
   * `filter_subjects` = its channels), so `consumers.list(CHAT)` already records the real
   * membership; we join it with presence so a lingering durable for a gone peer shows as a
   * stale ghost (`live: false`) rather than a phantom listener.
   *
   * `channelMembers("review")` → that channel's members; `channelMembers()` → every channel
   * mapped to its members. A member on a wildcard (`team.>`) counts for every concrete
   * channel it subsumes (`team.backend`) — membership is the *effective subscription*.
   *
   * Privileged read: `consumers.list` needs `$JS.API.CONSUMER.LIST.<chat stream>`, which only
   * the allow-all manager profile holds today (agents, observer, and admin are all denied), so
   * this is not an agent-facing capability — serving it from a dashboard profile is a one-line
   * ACL grant away.
   */
  async channelMembers(channel: string): Promise<ChannelMember[]>;
  async channelMembers(): Promise<Map<string, ChannelMember[]>>;
  async channelMembers(
    channel?: string,
  ): Promise<ChannelMember[] | Map<string, ChannelMember[]>> {
    const mgr = await this.manager();
    // Group channel patterns by each consumer's durable id-token (chat_<id> → token(id)).
    // One peer has one chat consumer, so this is a straight per-peer collection; join/leave
    // just mutates that consumer's filter_subjects, which the next call re-reads live.
    const byTok = new Map<string, Set<string>>();
    for await (const ci of mgr.consumers.list(chatStream(this.space))) {
      const tok = chatDurableToken(ci.config.durable_name ?? ci.name);
      if (tok === null) continue;
      // The server may report a single filter as `filter_subject` or `filter_subjects` — both
      // are the same datum; read whichever is present. Filters are already collapsed (the
      // effective subscription), so parse the channel straight out of each.
      const filters =
        ci.config.filter_subjects ?? (ci.config.filter_subject ? [ci.config.filter_subject] : []);
      const set = byTok.get(tok) ?? new Set<string>();
      for (const f of filters) {
        const p = parseSubject(f);
        if (p?.kind === "chat") set.add(p.rest);
      }
      byTok.set(tok, set);
    }

    // Join with presence for liveness. token() is lossy, so match forward: index the roster
    // by token(id). A durable with no roster match is a ghost/foreign id — keep its token,
    // never drop it.
    const byToken = new Map<string, Presence>();
    for (const p of this.roster.values()) byToken.set(token(p.card.id), p);
    const memberFor = (tok: string): ChannelMember => {
      const p = byToken.get(tok);
      return p
        ? { id: p.card.id, name: p.card.name, role: p.card.role, live: p.status !== "offline" }
        : { id: tok, name: tok, live: false };
    };
    const byName = (a: ChannelMember, b: ChannelMember) => a.name.localeCompare(b.name);

    if (channel !== undefined) {
      const out: ChannelMember[] = [];
      for (const [tok, patterns] of byTok)
        if ([...patterns].some((pat) => subjectMatches(pat, channel))) out.push(memberFor(tok));
      return out.sort(byName);
    }

    const map = new Map<string, ChannelMember[]>();
    for (const [tok, patterns] of byTok) {
      const m = memberFor(tok);
      for (const pat of patterns) {
        const arr = map.get(pat);
        if (arr) arr.push(m);
        else map.set(pat, [m]);
      }
    }
    for (const arr of map.values()) arr.sort(byName);
    return map;
  }

  /** Fetch recent messages from a channel's JetStream backlog. */
  async channelHistory(
    channel: string,
    opts?: { limit?: number },
  ): Promise<CotalMessage[]> {
    // history from any sender
    return this.streamHistory(
      chatStream(this.space),
      chatSubject(this.space, "*", channel),
      opts?.limit ?? 100,
    );
  }

  /** Fetch recent DMs (any sender→any recipient) from the space's DM backlog. God-view only:
   *  a normal agent/observer's ACL denies CONSUMER.CREATE on DM_<space>, so this throws-and-
   *  skips for them — only an `admin`-profile cred can read it. */
  async dmHistory(opts?: { limit?: number }): Promise<CotalMessage[]> {
    // every inst.<target>.<sender> DM
    return this.streamHistory(
      dmStream(this.space),
      unicastSubject(this.space, "*", "*"),
      opts?.limit ?? 100,
    );
  }

  /** Drain up to `limit` recent messages matching `subject` from a stream's backlog via a
   *  throwaway consumer. Fetches exactly the pending count (from consumer info) so it returns
   *  the moment the backlog is delivered — a plain `fetch({max_messages: limit})` would instead
   *  block for the pull's full expiry (~30s) whenever the backlog is smaller than `limit`. */
  private async streamHistory(
    stream: string,
    subject: string,
    limit: number,
  ): Promise<CotalMessage[]> {
    if (!this.nc) throw new Error("endpoint not started");
    const js = jetstream(this.nc);
    const msgs: CotalMessage[] = [];
    try {
      const consumer = await js.consumers.get(stream, { filter_subjects: [subject] });
      const pending = Math.min(limit, (await consumer.info()).num_pending);
      if (pending === 0) return msgs;
      const iter = await consumer.fetch({ max_messages: pending });
      for await (const m of iter) {
        try {
          msgs.push(m.json<CotalMessage>());
        } catch {
          /* skip undecodable */
        }
      }
    } catch {
      /* stream missing or consumer create denied (non-admin) */
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

  private async publishMsg(subject: string, msg: CotalMessage): Promise<void> {
    if (!this.js) throw new Error("endpoint not started");
    // msgID = message id → free server-side dedup across JetStream redelivery.
    await this.js.publish(subject, JSON.stringify(msg), { msgID: msg.id });
  }

  /** Create the three backing streams for this space (idempotent). Open-mode lazy create;
   *  the same definitions are used by `cotal up` at privileged setup. */
  private async ensureStreams(): Promise<void> {
    if (!this.jsm) throw new Error("endpoint not started");
    await createSpaceStreams(this.jsm, this.space);
  }

  /**
   * Privileged: pre-create an agent's DM inbox durable (auth mode), so the agent can BIND
   * it without holding CONSUMER.CREATE on DM_<space>. The creator sets the filter to
   * inst.<targetId>.* — the agent never gets to choose it, which is what stops a peer from
   * creating a durable filtered to someone else's inbox. Idempotent (byte-identical config),
   * safe to call again on manager restart. The caller must be permissive on DM_<space>.
   */
  async provisionDmInbox(targetId: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(dmStream(this.space), dmDurableConfig(this.space, targetId));
  }

  /**
   * Privileged: pre-create a role's shared TASK work-queue durable (auth mode), so agents
   * of that role can BIND it without holding CONSUMER.CREATE on TASK_<space>. The creator
   * sets the filter to svc.<role>.* — agents never choose it, which stops cross-role drain.
   * Idempotent per role. The caller must be permissive on TASK_<space>.
   */
  async provisionTaskQueue(role: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(taskStream(this.space), taskDurableConfig(this.space, role));
  }

  /** Lazily obtain a JetStream manager — so a non-consuming endpoint (e.g. the supervisor,
   *  consume:false) can still pre-create others' durables. */
  private async manager(): Promise<JetStreamManager> {
    if (!this.nc) throw new Error("endpoint not started");
    this.jsm ??= await jetstreamManager(this.nc);
    return this.jsm;
  }

  /** Bind this endpoint's durable consumers: DM inbox, chat, and (if a role) the task queue. */
  private async startConsumers(): Promise<void> {
    if (!this.jsm) throw new Error("endpoint not started");
    const id = this.card.id;
    const ack_wait = nanos(this.ackWaitMs);
    const inactive_threshold = nanos(this.inactiveThresholdMs);

    // Unicast: this instance's private DM inbox. Open mode self-creates; auth mode BINDS a
    // durable the provisioner pre-created (agents are denied CONSUMER.CREATE on DM_<space>,
    // since the create-time filter_subject is the attack surface — see provisionDmInbox).
    if (!this.creds) {
      await this.jsm.consumers.add(
        dmStream(this.space),
        dmDurableConfig(this.space, id, {
          ackWaitMs: this.ackWaitMs,
          inactiveThresholdMs: this.inactiveThresholdMs,
        }),
      );
    }
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
    // Open mode self-creates; auth mode BINDS the provisioner-pre-created svc_<role>
    // durable (agents are denied CONSUMER.CREATE on TASK_<space>, since the create-time
    // filter is the cross-role-drain attack surface — see provisionTaskQueue).
    if (this.card.role) {
      if (!this.creds) {
        await this.jsm.consumers.add(
          taskStream(this.space),
          taskDurableConfig(this.space, this.card.role, { ackWaitMs: this.ackWaitMs }),
        );
      }
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
        let msg: CotalMessage;
        try {
          msg = m.json<CotalMessage>();
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

  /** Watch the channel registry: replay existing keys, then stream updates, into the local
   *  cache. Best-effort — a registry the endpoint can't read leaves the cache empty (effective
   *  policy then falls back to the default), never a fault. */
  private async startChannelWatch(): Promise<void> {
    if (!this.channelKv) return;
    const iter = await this.channelKv.watch();
    void (async () => {
      for await (const e of iter) this.handleChannelEntry(e);
    })().catch((e) => this.emit("error", e as Error));
  }

  private handleChannelEntry(e: KvEntry): void {
    const gone = e.operation === "DEL" || e.operation === "PURGE";
    if (e.key === CHANNEL_DEFAULTS_KEY) {
      if (gone) this.channelDefaults = {};
      else
        try {
          this.channelDefaults = e.json<ChannelDefaults>();
        } catch {
          /* keep last good */
        }
      return;
    }
    if (gone) {
      this.channelConfigs.delete(e.key);
      return;
    }
    try {
      this.channelConfigs.set(e.key, e.json<ChannelConfig>());
    } catch {
      /* keep last good */
    }
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

/** The id token of a chat-stream durable, or null if it isn't one — the inverse of
 *  `chatDurable` (`chat_<token(id)>`). token() is lossy, so this returns the token, not the
 *  original id; callers match it forward against `token(card.id)`. */
function chatDurableToken(durable: string): string | null {
  const prefix = "chat_";
  return durable.startsWith(prefix) ? durable.slice(prefix.length) : null;
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

/** Whether a NATS server is *running* at `servers`. True on a successful connect AND on an
 *  auth rejection — an auth error means a server is there, just refusing these creds (so the
 *  caller should surface the real auth failure, not a misleading "server down", and `up`
 *  must not try to start a duplicate on the bound port). Only a genuine connection failure
 *  (refused / timeout / no server) returns false. */
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
  } catch (e) {
    return e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError;
  }
}
