import {
  SwarlEndpoint,
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
 */
export class MeshAgent {
  readonly ep: SwarlEndpoint;
  readonly config: AgentConfig;

  private inbox: InboxItem[] = [];
  private _connected = false;
  private stopping = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.ep = new SwarlEndpoint({
      space: config.space,
      servers: config.servers,
      channels: config.channels,
      card: { name: config.name, role: config.role, kind: config.kind },
    });
    this.ep.on("message", (m: SwarlMessage) => this.ingest(m));
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

  private ingest(m: SwarlMessage): void {
    const text = m.parts
      .map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data)))
      .join(" ");
    const kind: InboxItem["kind"] = m.to ? "dm" : m.toService ? "anycast" : "channel";
    this.inbox.push({
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
    });
    if (this.inbox.length > MAX_INBOX) {
      this.inbox.splice(0, this.inbox.length - MAX_INBOX);
    }
  }

  /** Return pending messages and clear them. */
  drainInbox(limit?: number): InboxItem[] {
    const n = limit && limit > 0 ? Math.min(limit, this.inbox.length) : this.inbox.length;
    return this.inbox.splice(0, n);
  }

  /** Return pending messages without clearing them. */
  peekInbox(): InboxItem[] {
    return [...this.inbox];
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

  async setStatus(status: PresenceStatus, activity?: string): Promise<void> {
    this.assertConnected();
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
