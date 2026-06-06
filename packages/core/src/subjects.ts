/**
 * Subject naming — the routing half of the wire contract (v0).
 *
 *   swarl.<space>.chat.<channel>      multicast to a channel (dotted + hierarchical: team.backend, subscribe team.>)
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

/**
 * Build the channel portion of a chat subject, preserving NATS hierarchy: split on
 * `.`, sanitize each segment to a safe token, but keep whole-segment wildcards
 * (`*` = one level, `>` = the rest). So `team.backend` → `team.backend` (a
 * sub-channel) and `team.>` → `team.>` (its whole subtree). `>` is only legal as
 * the final segment; empty segments are dropped.
 */
function channelPath(channel: string): string {
  const segs = channel.split(".").map((s) => s.trim()).filter((s) => s.length > 0);
  if (segs.length === 0) return "_";
  return segs
    .map((s, i) => {
      if (s === ">") {
        if (i !== segs.length - 1)
          throw new Error(`channel "${channel}": '>' is only valid as the last segment`);
        return ">";
      }
      return s === "*" ? "*" : token(s);
    })
    .join(".");
}

export function chatSubject(space: string, channel: string): string {
  return `${spacePrefix(space)}.chat.${channelPath(channel)}`;
}

/** True if a channel names a concrete sub-channel (no `*`/`>`) — i.e. it can be
 *  *published* to. Subscriptions may be wildcard; publishes must be concrete. */
export function isConcreteChannel(channel: string): boolean {
  return !channel.split(".").some((s) => s.trim() === "*" || s.trim() === ">");
}

/** Does NATS subject `pattern` (with `*`/`>`) match `subject`? */
function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return true; // matches all remaining tokens
    if (i >= s.length) return false;
    if (p[i] === "*") continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/** Drop exact duplicates and any subject subsumed by a more-general one — JetStream
 *  rejects a consumer whose `filter_subjects` overlap, so `[team.>, team.backend]`
 *  must collapse to `[team.>]` before binding the chat consumer. */
export function collapseFilterSubjects(subjects: string[]): string[] {
  const uniq = [...new Set(subjects)];
  return uniq.filter((x) => !uniq.some((y) => y !== x && subjectMatches(y, x)));
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

/** The three peer-message delivery modes (control/trace/presence are not deliveries). */
export type DeliveryMode = "chat" | "anycast" | "unicast";

/**
 * Inverse of the subject builders: classify a subject's delivery mode, or `null` for
 * control/trace/etc. Observers (e.g. a feed) use this instead of re-parsing the layout.
 */
export function deliveryOf(subject: string): DeliveryMode | null {
  const kind = subject.split(".")[2]; // swarl.<space>.<kind>.<token>
  return kind === "chat" ? "chat" : kind === "svc" ? "anycast" : kind === "inst" ? "unicast" : null;
}

/** Name of the KV bucket holding presence for a space. */
export function presenceBucket(space: string): string {
  return `swarl_presence_${token(space)}`;
}

// ---- JetStream streams (the durable backing for the three delivery modes) ----

/** Stream capturing `chat.>` — multicast backlog + history. */
export function chatStream(space: string): string {
  return `CHAT_${token(space)}`;
}

/** Stream capturing `inst.>` — per-instance direct-message inboxes. */
export function dmStream(space: string): string {
  return `DM_${token(space)}`;
}

/** Stream capturing `svc.>` — anycast work queue. */
export function taskStream(space: string): string {
  return `TASK_${token(space)}`;
}

/** Durable consumer name for an instance's view of the chat stream. */
export function chatDurable(instance: string): string {
  return `chat_${token(instance)}`;
}

/** Durable consumer name for an instance's private DM inbox. */
export function dmDurable(instance: string): string {
  return `dm_${token(instance)}`;
}

/** Durable consumer name (shared across instances of a role) for the task queue. */
export function taskDurable(service: string): string {
  return `svc_${token(service)}`;
}
