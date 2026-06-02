/**
 * Subject naming — the routing half of the wire contract (v0).
 *
 *   swarl.<space>.chat.<channel>     broadcast to a named channel
 *   swarl.<space>.dm.<peerId>        direct message to one peer
 *   swarl.<space>.trace.<agentId>    ambient lifecycle trace (later)
 *   swarl.<space>.control.<agentId>  control-plane commands (later)
 *
 * Presence lives in a JetStream KV bucket, not a subject (see presenceBucket()).
 */

const ILLEGAL = /[^A-Za-z0-9_-]/g;

/** Make a string safe to use as a single NATS subject token. */
export function token(s: string): string {
  const t = s.trim().replace(ILLEGAL, "_");
  return t.length > 0 ? t : "_";
}

export const ROOT = "swarl";

export function spacePrefix(space: string): string {
  return `${ROOT}.${token(space)}`;
}

export function chatSubject(space: string, channel: string): string {
  return `${spacePrefix(space)}.chat.${token(channel)}`;
}

export function dmSubject(space: string, peerId: string): string {
  return `${spacePrefix(space)}.dm.${token(peerId)}`;
}

export function traceSubject(space: string, agentId: string): string {
  return `${spacePrefix(space)}.trace.${token(agentId)}`;
}

export function controlSubject(space: string, agentId: string): string {
  return `${spacePrefix(space)}.control.${token(agentId)}`;
}

/** Wildcard matching every subject within a space. */
export function spaceWildcard(space: string): string {
  return `${spacePrefix(space)}.>`;
}

/** Name of the KV bucket holding presence for a space. */
export function presenceBucket(space: string): string {
  return `swarl_presence_${token(space)}`;
}
