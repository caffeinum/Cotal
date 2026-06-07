import {
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  DiscardPolicy,
  StorageType,
  type ConsumerConfig,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { connect, credsAuthenticator, nanos } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  spacePrefix,
  chatStream,
  dmStream,
  dmDurable,
  unicastSubject,
  taskStream,
  taskDurable,
  anycastSubject,
  presenceBucket,
} from "./subjects.js";

/** Default presence-bucket entry TTL (ms) — matches the endpoint's default liveness window. */
const PRESENCE_TTL_MS = 6_000;

/**
 * Create (idempotently) the three backing streams for a space — CHAT (multicast backlog +
 * history), DM (per-instance inboxes), TASK (anycast work queue).
 *
 * This is **privileged**: under auth mode `STREAM.CREATE` is denied to regular agents
 * (streams are space infrastructure, not per-agent), so it runs once at setup
 * (`swarl up`) or from a permissive endpoint. The single source of the stream
 * definitions, shared by the endpoint and the setup path so they can't diverge.
 */
export async function createSpaceStreams(
  jsm: JetStreamManager,
  space: string,
): Promise<void> {
  const p = spacePrefix(space);
  await jsm.streams.add({
    name: chatStream(space),
    subjects: [`${p}.chat.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_msgs_per_subject: 1000, // capped per-channel backlog (buffer + history)
    discard: DiscardPolicy.Old,
  });
  await jsm.streams.add({
    name: dmStream(space),
    subjects: [`${p}.inst.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
  });
  await jsm.streams.add({
    name: taskStream(space),
    subjects: [`${p}.svc.>`],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
  });
}

/**
 * The DM inbox durable for an instance — ONE definition, used both by the privileged
 * pre-create (manager/provisioner, auth mode) and the endpoint's open-mode self-create, so
 * an idempotent re-add can never error on a config delta. The `filter_subject` binds the
 * durable to inst.<id>.* — only the privileged creator sets it, which is the whole point:
 * an agent can't create a durable filtered to someone else's inbox.
 */
export function dmDurableConfig(
  space: string,
  id: string,
  opts: { ackWaitMs?: number; inactiveThresholdMs?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: dmDurable(id),
    filter_subject: unicastSubject(space, id, "*"),
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
    inactive_threshold: nanos(opts.inactiveThresholdMs ?? 600_000),
  };
}

/**
 * The TASK work-queue durable for a role — ONE definition, shared by the privileged
 * pre-create (auth mode) and the endpoint's open-mode self-create. The durable is shared
 * across all instances of a role (queue group); the privileged creator sets the
 * filter_subject to svc.<role>.* so an agent can't bind a consumer filtered to another
 * role's queue (the same create-time-filter attack surface as DM). Idempotent per role.
 */
export function taskDurableConfig(
  space: string,
  role: string,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: taskDurable(role),
    filter_subject: anycastSubject(space, role, "*"),
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
  };
}

/** Connect with the given (privileged) creds, create the space's streams, and disconnect.
 *  Used by `swarl up` to pre-create streams once at setup. */
export async function setupSpaceStreams(opts: {
  servers: string;
  space: string;
  creds: string;
}): Promise<void> {
  const nc = await connect({
    servers: opts.servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)),
  });
  try {
    await createSpaceStreams(await jetstreamManager(nc), opts.space);
    // The presence KV bucket is a stream too — pre-create it so agents (denied KV
    // stream-create) can open it. Idempotent.
    await new Kvm(nc).create(presenceBucket(opts.space), { ttl: PRESENCE_TTL_MS });
  } finally {
    await nc.drain();
  }
}
