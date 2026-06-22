/**
 * Durable-membership registry — read/write helpers over the per-space members KV bucket
 * (`cotal_members_<space>`). One {@link MembershipRecord} per (concrete channel, owner) under
 * {@link memberKey}. This is the Plane-3 source of truth for `channelMembers()` and the fan-out's
 * member list, **moved off JetStream consumer topology** (core-sub joins create no consumer to
 * enumerate — the migration trap).
 *
 * Writes are **privileged** (the manager / open-mode self-write); agent-authored membership is
 * forbidden — it would self-authorize durable-backstop delivery + reads. Every write is guarded
 * two ways: a **generation** monotonicity check (a stale control reply with an older generation is
 * rejected, so it can't clobber a newer tombstone or rejoin) and a KV **revision CAS** (a concurrent
 * same-generation write is retried against the fresh revision). Eligibility is always by CHAT stream
 * **sequence** (`joinCursor`/`leaveCursor`), never wall-clock.
 */
import { Kvm, type KV } from "@nats-io/kv";
import { membersBucket, memberKey, parseMemberKey } from "./subjects.js";
import type { MembershipRecord } from "./types.js";

/** Thrown when a write would regress membership generation — a stale/late control reply. Callers
 *  treat this as "a newer membership change already won", not an error to retry. */
export class StaleMembershipWrite extends Error {
  constructor(channel: string, owner: string, attempted: number, current: number) {
    super(
      `stale membership write for ${channel}/${owner}: generation ${attempted} < current ${current}`,
    );
    this.name = "StaleMembershipWrite";
  }
}

/** Open the members registry bucket. Auth mode OPENs the bucket pre-created at `cotal up`; open dev
 *  mode lazily CREATEs it. Mirrors {@link openChannelRegistry}. */
export async function openMembersRegistry(
  nc: import("@nats-io/transport-node").NatsConnection,
  space: string,
  opts: { create?: boolean } = {},
): Promise<KV> {
  const kvm = new Kvm(nc);
  return opts.create ? kvm.create(membersBucket(space)) : kvm.open(membersBucket(space));
}

/** Read one membership record (incl. a tombstone — `leaveCursor` set), or undefined if no record /
 *  the key was deleted. The CAS revision is returned alongside so a caller can do its own
 *  read-modify-write; most callers use {@link commitMember}/{@link tombstoneMember} instead. */
export async function readMember(
  kv: KV,
  channel: string,
  owner: string,
): Promise<{ record: MembershipRecord; revision: number } | undefined> {
  const e = await kv.get(memberKey(channel, owner));
  if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
  try {
    return { record: e.json<MembershipRecord>(), revision: e.revision };
  } catch {
    return undefined;
  }
}

/**
 * Commit a membership record with the generation guard + revision CAS. `next` is the full intended
 * record (the caller has already validated the channel ⊆ ACL, concrete, etc.). Returns the committed
 * record. Throws {@link StaleMembershipWrite} if `next.generation` is older than what's stored.
 * Retries a revision conflict (a concurrent same-or-newer write) by re-reading; if the re-read shows
 * a newer generation, that surfaces as `StaleMembershipWrite` too — last writer by generation wins,
 * deterministically.
 */
export async function commitMember(kv: KV, next: MembershipRecord): Promise<MembershipRecord> {
  const key = memberKey(next.channel, next.owner);
  const data = new TextEncoder().encode(JSON.stringify(next));
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readMember(kv, next.channel, next.owner);
    if (!cur) {
      try {
        await kv.create(key, data);
        return next;
      } catch {
        continue; // lost the create race — re-read and try as an update
      }
    }
    if (next.generation < cur.record.generation)
      throw new StaleMembershipWrite(next.channel, next.owner, next.generation, cur.record.generation);
    try {
      await kv.update(key, data, cur.revision);
      return next;
    } catch {
      continue; // revision moved under us — re-read and retry (generation guard re-checks)
    }
  }
  throw new Error(`members CAS exhausted retries for ${key}`);
}

/**
 * Tombstone a membership at `leaveCursor` (leave). Reads the current record and writes it back with
 * `leaveCursor` set + `state: "live-confirmed"` (the durable backstop is closed), keeping its
 * generation — so a later rejoin (a NEWER generation) wins, and a stale leave reply (an OLDER
 * generation than what's stored, e.g. the agent already rejoined) is rejected. A no-op if there is
 * no record (already gone) or it is already tombstoned at/below this cursor.
 */
export async function tombstoneMember(
  kv: KV,
  channel: string,
  owner: string,
  leaveCursor: number,
  writerIdentity: string,
  expectedGeneration?: number,
): Promise<MembershipRecord | undefined> {
  const cur = await readMember(kv, channel, owner);
  if (!cur) return undefined;
  // Stale-leave guard: a leave is for the generation the agent joined with (`expectedGeneration`,
  // captured at durableJoin). If the record has since moved to a NEWER generation — the agent left
  // and REJOINED — this stale leave must NOT tombstone the rejoin (it would durable-disable a live
  // membership). Refuse it. (Same intent as the generation guard in commitMember, but a leave reads
  // the current record so it needs the caller's expected generation to detect the rejoin.)
  if (expectedGeneration !== undefined && cur.record.generation !== expectedGeneration)
    throw new StaleMembershipWrite(channel, owner, expectedGeneration, cur.record.generation);
  if (cur.record.leaveCursor !== undefined && cur.record.leaveCursor <= leaveCursor)
    return cur.record; // already left at/before this cursor
  const next: MembershipRecord = {
    ...cur.record,
    state: "live-confirmed",
    leaveCursor,
    writerIdentity,
    updatedAt: Date.now(),
  };
  return commitMember(kv, next);
}

/** Permanently remove a membership record (GC / footprint deletion — revocation deletes the footprint
 *  AFTER invalidating creds). Distinct from {@link tombstoneMember}, which keeps the record so late
 *  durable entries are denied by the cursor; only call this past the retention horizon. */
export async function deleteMember(kv: KV, channel: string, owner: string): Promise<void> {
  await kv.purge(memberKey(channel, owner));
}

/**
 * Scan the registry, yielding every live (non-deleted) record matching the filter. `channel` →
 * that channel's members (fan-out's per-channel list); `owner` → that owner's memberships. With no
 * filter, every record. MVP does a full `keys()` scan + per-key get + in-code filter — correct and
 * fine at local scale; a derived channel→members index is the deferred web-scale optimization
 * (the registry stays the single canonical source). Tombstones (with `leaveCursor`) ARE yielded —
 * a caller that wants only currently-open memberships filters on `leaveCursor === undefined`.
 */
export async function listMembers(
  kv: KV,
  filter: { channel?: string; owner?: string } = {},
): Promise<MembershipRecord[]> {
  const out: MembershipRecord[] = [];
  for await (const key of await kv.keys()) {
    const parsed = parseMemberKey(key);
    if (!parsed) continue;
    if (filter.channel !== undefined && parsed.channel !== filter.channel) continue;
    if (filter.owner !== undefined && parsed.owner !== filter.owner) continue;
    const rec = await readMember(kv, parsed.channel, parsed.owner);
    if (rec) out.push(rec.record);
  }
  return out;
}

/** True if a record makes the owner an **eligible durable recipient** for a CHAT message at `seq`:
 *  the membership interval `joinCursor < seq <= leaveCursor` (open leave ⇒ no upper bound). The
 *  single interval rule shared by fan-out routing and the trusted reader's re-auth (SPEC §7
 *  L355-356) so they can't drift. State must be `durable-active` (a `live-confirmed` record has no
 *  Plane-3 backstop). */
export function durableEligible(rec: MembershipRecord, seq: number): boolean {
  // Only a fully-ACTIVATED record carries a backstop: a `durable-active` record whose activation
  // catch-up has not completed (`activated` false) is NON-routing — fan-out + the reader skip it, so a
  // join reported `durable:false` never gets routed (panel honesty gate). A tombstone keeps its
  // `activated` and stays interval-eligible for its PRE-leave window (`seq <= leaveCursor`) — "leave is
  // a hard read boundary" is the leaveCursor cutoff, not a drop of in-interval entries (SPEC §7). A
  // plain live-confirmed/boot record (never activated) is not a durable recipient.
  if (!rec.activated) return false;
  if (seq <= rec.joinCursor) return false;
  if (rec.leaveCursor !== undefined && seq > rec.leaveCursor) return false;
  return true;
}
