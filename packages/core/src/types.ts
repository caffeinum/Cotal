/**
 * Cotal wire types (v0).
 *
 * These are the shapes that travel on the mesh. They are intentionally A2A-inspired
 * (AgentCard / Message / Part) but transport-agnostic. This file IS part of the
 * "wire contract" — treat changes here as protocol changes.
 */

export type EndpointKind = "agent" | "endpoint";

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
}

/** A2A-inspired identity record for an endpoint or agent. */
export interface AgentCard {
  /** Unique, stable for the lifetime of this connection. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** 'agent' (participates in coordination) or a plain 'endpoint' (logger, dashboard…). */
  kind: EndpointKind;
  /** Cotal addition: the role this participant plays (planner, reviewer, …). */
  role?: string;
  /** A2A-style one-line summary of what this agent does (discovery / observability). */
  description?: string;
  /** Cotal: free-form "what it can do" tags (A2A skill-tags, flattened) — discovery only. */
  tags?: string[];
  skills?: AgentSkill[];
  meta?: Record<string, unknown>;
}

/**
 * Lifecycle status of a participant.
 * - `idle`: connected, no active task
 * - `waiting`: blocked — awaiting input, approval, or a peer
 * - `working`: actively executing a task / in a turn
 * - `offline`: disconnected or heartbeat lapsed (derived by observers, not self-set while live)
 */
export type PresenceStatus = "idle" | "waiting" | "working" | "offline";

/** Live presence record. Stored in the space's KV bucket under key = card.id. */
export interface Presence {
  card: AgentCard;
  status: PresenceStatus;
  /** Freeform "what I'm doing right now". */
  activity?: string;
  /** Epoch ms of the last heartbeat. */
  ts: number;
}

export type Part =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown };

export interface EndpointRef {
  id: string;
  name: string;
  role?: string;
}

/** A message on the mesh (chat / direct message for now; extensible to other families). */
export interface CotalMessage {
  /** Unique message id. */
  id: string;
  /** Epoch ms. */
  ts: number;
  space: string;
  from: EndpointRef;
  // Delivery target — exactly one of the next three is set:
  /** Channel name — multicast (broadcast to everyone on the channel). */
  channel?: string;
  /** Instance id — unicast (direct to one specific endpoint). */
  to?: string;
  /** Service / role — anycast (any one instance of the service receives it). */
  toService?: string;
  /** Lowercased peer names called out within a `channel` message — a priority/wake hint,
   *  not a routing target: the message still multicasts to the whole channel. Omitted when
   *  empty. */
  mentions?: string[];
  parts: Part[];
  /** Id of the message being replied to. */
  replyTo?: string;
  /** Conversation / thread correlation id. */
  contextId?: string;
}

export type PresenceEvent =
  | { type: "join"; presence: Presence }
  | { type: "update"; presence: Presence }
  | { type: "offline"; presence: Presence };

/**
 * Delivery control handed to "message" listeners alongside each {@link CotalMessage}.
 * The message stays on its JetStream stream until {@link Delivery.ack} is called — so
 * ack ONLY once the message has actually been surfaced (printed, injected, handled).
 * A crash before ack redelivers it.
 */
export interface Delivery {
  /** Mark the message handled; advances this reader's bookmark so it won't redeliver. */
  ack(): void;
  /** Decline for now; the message redelivers (e.g. couldn't surface it yet). */
  nak(): void;
}

/** Control-plane request/reply (e.g. CLI → manager). */
export interface ControlRequest {
  op: string;
  args?: Record<string, unknown>;
  from?: EndpointRef;
}

export interface ControlReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}
