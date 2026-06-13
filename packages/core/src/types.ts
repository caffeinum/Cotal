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

/**
 * Channel registry entry — channel-global config, stored in the per-space channels KV
 * (one entry per channel; the space-wide default lives under {@link CHANNEL_DEFAULTS_KEY}).
 * Shared across every peer, not a per-subscriber choice. `description`/`instructions` reach
 * the model, so this is a prompt-injection surface: writes are privileged and both text
 * fields are length-bounded at the write path (see channels.ts).
 */
export interface ChannelConfig {
  /** Override the space default for history replay-on-join. */
  replay?: boolean;
  /** How far back a joiner's backfill reaches — a duration like `"24h"`, `"30m"`, `"7d"`.
   *  Maps to a native Direct-Get `start_time` (now − window). Unset + `replay` ⇒ the full
   *  retained window; ignored when replay is off. */
  replayWindow?: string;
  /** One-line "what this channel is for". */
  description?: string;
  /** Longer "how to use it" — surfaced to joiners as advisory, attributed data. */
  instructions?: string;
}

/** Space-wide channel defaults, stored under {@link CHANNEL_DEFAULTS_KEY}. */
export interface ChannelDefaults {
  replay?: boolean;
  replayWindow?: string;
}

/**
 * A renderable view — a json-render "flat spec" (vercel-labs/json-render): a root element key
 * plus a flat map of elements, each naming a catalog component `type`, its `props`, and its
 * child element keys. Carried as a {@link Part} so a peer can publish a *view* (a table, chart,
 * status panel) instead of plain text; a viewer renders it against a fixed component catalog —
 * the guardrail: only declared components, validated props, never arbitrary code. Structural by
 * design — core owns the wire shape, the renderer (a thin client) owns the catalog.
 */
export interface ViewElement {
  /** Catalog component name (e.g. "Box", "Text", "Table", "StatusLine"). */
  type: string;
  props?: Record<string, unknown>;
  /** Child element keys (flat reference into {@link ViewSpec.elements}). */
  children?: string[];
}

export interface ViewSpec {
  /** Key of the root element in {@link elements}. */
  root: string;
  elements: Record<string, ViewElement>;
  /** Optional seed state for dynamic (`$state`) props. */
  state?: Record<string, unknown>;
}

/** Throw unless `spec` is a structurally valid {@link ViewSpec} (root key present, `elements`
 *  is an object, the root resolves). A cheap publish-time guard — component-level validation
 *  (are these real catalog components, with valid props?) is the renderer's job. */
export function assertViewSpec(spec: ViewSpec): void {
  if (!spec || typeof spec.root !== "string" || spec.root.length === 0)
    throw new Error("invalid view spec: missing root element key");
  if (!spec.elements || typeof spec.elements !== "object")
    throw new Error("invalid view spec: elements must be an object");
  if (!spec.elements[spec.root])
    throw new Error(`invalid view spec: root "${spec.root}" is not present in elements`);
}

export type Part =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown }
  | { kind: "view"; spec: ViewSpec };

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

/** Context delivered as the 3rd arg of a "message" event. `historical` marks a message
 *  replayed from a channel's backlog on join (a "catching up" block) vs a live message —
 *  so a joiner doesn't act on a resolved 2-hour-old thread as if it were live. */
export interface MessageMeta {
  historical: boolean;
  /** Authenticated message class, derived from the **delivering NATS subject** (NOT the
   *  forgeable payload routing fields `to`/`toService`). `channel` = multicast (chat.*),
   *  `dm` = unicast (inst.*), `anycast` = a role's work-queue (svc.*). This is the only
   *  trustworthy "how was this addressed to me" signal: a peer can put your id in payload
   *  `to`, but it cannot publish on your private DM subject — so directedness rides this,
   *  never the payload. */
  kind: "channel" | "dm" | "anycast";
}

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
