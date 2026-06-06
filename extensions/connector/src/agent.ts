import { EventEmitter } from "node:events";
import {
  SwarlEndpoint,
  type Delivery,
  type Presence,
  type PresenceStatus,
  type SwarlMessage,
} from "@swarl/core";
import type { AgentConfig } from "./config.js";

/** A message that has arrived for us, normalized for the agent to read. */
export interface InboxItem {
  id: string;
  ts: number;
  fromId: string;
  fromName: string;
  fromRole?: string;
  kind: "channel" | "dm" | "anycast";
  /** Set when kind === "channel". */
  channel?: string;
  /** Set when kind === "anycast" (the role addressed). */
  service?: string;
  text: string;
  replyTo?: string;
  contextId?: string;
}

/** An inbox entry: the normalized message plus its JetStream ack handle. */
interface Pending {
  item: InboxItem;
  /** Ack the backing stream message — called only once the item is actually surfaced. */
  ack: () => void;
}

const MAX_INBOX = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A thin, mesh-native agent: a {@link SwarlEndpoint} plus a buffered inbox and
 * name-based peer resolution. This is the shared core behind the MCP server
 * (and, later, the lifecycle hooks) — it owns the NATS connection and presence.
 *
 * Connecting is resilient: {@link start} kicks off a background retry loop so the
 * MCP server is responsive immediately even if the mesh isn't up yet.
 *
 * Emits `"incoming"` (InboxItem) after each message is buffered, so a push layer
 * (the channel) can deliver it immediately; `"error"` (Error) for endpoint faults.
 */
export class MeshAgent extends EventEmitter {
  readonly ep: SwarlEndpoint;
  readonly config: AgentConfig;

  private inbox: Pending[] = [];
  private _connected = false;
  private _status: PresenceStatus = "idle";
  private stopping = false;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.ep = new SwarlEndpoint({
      space: config.space,
      servers: config.servers,
      token: config.token,
      user: config.user,
      pass: config.pass,
      tls: config.tls,
      channels: config.channels,
      card: {
        name: config.name,
        role: config.role,
        kind: config.kind,
        description: config.description,
        capabilities: config.capabilities,
      },
    });
    this.ep.on("message", (m: SwarlMessage, d: Delivery) => this.ingest(m, d));
    this.ep.on("error", (e: Error) => this.log(`endpoint error: ${e.message}`));
  }

  get id(): string {
    return this.ep.card.id;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Begin connecting (with background retry). Returns immediately. */
  start(retryMs = 3000): void {
    void this.connectLoop(retryMs);
  }

  private async connectLoop(retryMs: number): Promise<void> {
    while (!this.stopping && !this._connected) {
      try {
        await this.ep.start();
        this._connected = true;
        this.log(
          `connected to ${this.config.servers} as ${this.who()} in space "${this.config.space}" on #${this.config.channels.join(", #")}`,
        );
      } catch (e) {
        this.log(`mesh unreachable (${(e as Error).message}); retrying in ${retryMs}ms`);
        await sleep(retryMs);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this._connected) await this.ep.stop();
  }

  // ---- inbox ---------------------------------------------------------------

  private ingest(m: SwarlMessage, delivery: Delivery): void {
    // Redelivery (we held it unacked past ack_wait): keep one entry, take the freshest ack handle.
    const existing = this.inbox.find((p) => p.item.id === m.id);
    if (existing) {
      existing.ack = delivery.ack;
      return;
    }
    const text = m.parts
      .map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data)))
      .join(" ");
    const kind: InboxItem["kind"] = m.to ? "dm" : m.toService ? "anycast" : "channel";
    const item: InboxItem = {
      id: m.id,
      ts: m.ts,
      fromId: m.from.id,
      fromName: m.from.name,
      fromRole: m.from.role,
      kind,
      channel: m.channel,
      service: m.toService,
      text,
      replyTo: m.replyTo,
      contextId: m.contextId,
    };
    this.inbox.push({ item, ack: delivery.ack });
    if (this.inbox.length > MAX_INBOX) {
      // Pathological backlog: ack the overflow so it stops redelivering.
      for (const p of this.inbox.splice(0, this.inbox.length - MAX_INBOX)) p.ack();
    }
    this.emit("incoming", item);
  }

  /** Return pending messages and ack them — call only when they're actually surfaced to the model. */
  drainInbox(limit?: number): InboxItem[] {
    const n = limit && limit > 0 ? Math.min(limit, this.inbox.length) : this.inbox.length;
    const taken = this.inbox.splice(0, n);
    for (const p of taken) p.ack();
    return taken.map((p) => p.item);
  }

  /** Return pending messages without acking them (they stay on the stream). */
  peekInbox(): InboxItem[] {
    return this.inbox.map((p) => p.item);
  }

  inboxCount(): number {
    return this.inbox.length;
  }

  // ---- sending -------------------------------------------------------------

  async send(text: string, channel?: string): Promise<SwarlMessage> {
    this.assertConnected();
    return this.ep.multicast(text, channel ? { channel } : undefined);
  }

  async anycast(role: string, text: string): Promise<SwarlMessage> {
    this.assertConnected();
    return this.ep.anycast(role, text);
  }

  /** Resolve a peer by instance id (exact) or display name (case-insensitive, prefer present). */
  resolvePeer(target: string): Presence | undefined {
    const roster = this.ep.getRoster().filter((p) => p.card.id !== this.id);
    const byId = roster.find((p) => p.card.id === target);
    if (byId) return byId;
    const t = target.toLowerCase();
    const present = roster.filter((p) => p.status !== "offline");
    return (
      present.find((p) => p.card.name.toLowerCase() === t) ??
      roster.find((p) => p.card.name.toLowerCase() === t)
    );
  }

  async dm(target: string, text: string): Promise<{ msg: SwarlMessage; peer: Presence }> {
    this.assertConnected();
    const peer = this.resolvePeer(target);
    if (!peer) throw new Error(`no peer "${target}" in space "${this.config.space}"`);
    const msg = await this.ep.unicast(peer.card.id, text);
    return { msg, peer };
  }

  // ---- presence ------------------------------------------------------------

  /** The full roster, including ourselves. */
  roster(): Presence[] {
    return this.ep.getRoster();
  }

  /** Our last self-reported presence status. */
  get status(): PresenceStatus {
    return this._status;
  }

  async setStatus(status: PresenceStatus, activity?: string): Promise<void> {
    this.assertConnected();
    this._status = status;
    if (activity !== undefined) await this.ep.setActivity(activity);
    await this.ep.setStatus(status);
  }

  // ---- internals -----------------------------------------------------------

  private who(): string {
    return this.config.role ? `${this.config.name}/${this.config.role}` : this.config.name;
  }

  private assertConnected(): void {
    if (!this._connected) {
      throw new Error(
        `not connected to the mesh at ${this.config.servers} — is it running? (pnpm swarl up)`,
      );
    }
  }

  private log(msg: string): void {
    process.stderr.write(`[swarl-connector] ${msg}\n`);
  }
}
