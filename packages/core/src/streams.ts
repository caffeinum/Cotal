import {
  jetstreamManager,
  RetentionPolicy,
  DiscardPolicy,
  StorageType,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { spacePrefix, chatStream, dmStream, taskStream } from "./subjects.js";

/**
 * Create (idempotently) the three backing streams for a space — CHAT (multicast backlog +
 * history), DM (per-instance inboxes), TASK (anycast work queue).
 *
 * This is **privileged**: under auth mode `STREAM.CREATE` is denied to regular agents
 * (streams are space infrastructure, not per-agent), so it runs once at setup
 * (`swarl up --auth`) or from a permissive endpoint. The single source of the stream
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

/** Connect with the given (privileged) creds, create the space's streams, and disconnect.
 *  Used by `swarl up --auth` to pre-create streams once at setup. */
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
  } finally {
    await nc.drain();
  }
}
