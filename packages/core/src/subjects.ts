/**
 * Subject naming — the routing half of the wire contract (v0).
 *
 *   swarl.<space>.chat.<channel>      multicast to a named channel
 *   swarl.<space>.svc.<service>       anycast to any one instance of a service (queue group)
 *   swarl.<space>.inst.<instance>     unicast to one specific instance
 *   swarl.<space>.ctl.<service>       control request/reply to a service (e.g. manager)
 *   swarl.<space>.trace.<instance>    ambient lifecycle trace (later)
 *   swarl.<space>.control.<instance>  control-plane commands (later)
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

/** Unicast: a specific instance's inbox. */
export function unicastSubject(space: string, instance: string): string {
  return `${spacePrefix(space)}.inst.${token(instance)}`;
}

/** Anycast: a service (role). Subscribers join a queue group so one instance receives. */
export function anycastSubject(space: string, service: string): string {
  return `${spacePrefix(space)}.svc.${token(service)}`;
}

/** Control request/reply to a service (e.g. the manager); anycast via queue group. */
export function controlServiceSubject(space: string, service: string): string {
  return `${spacePrefix(space)}.ctl.${token(service)}`;
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
