/**
 * Channel registry — the read/write helpers over the per-space channels KV bucket.
 *
 * The bucket holds one {@link ChannelConfig} per channel (key = the concrete channel token)
 * plus the space-wide defaults under {@link CHANNEL_DEFAULTS_KEY}. Writes are **privileged**
 * (manager / `cotal up` / `cotal channels`); agents read it (the live cache lives on the
 * endpoint). Because description/instructions reach the model, both text fields are bounded
 * here and oversize is **rejected at the write path** — never silently truncated.
 */
import { Kvm, type KV } from "@nats-io/kv";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { channelBucket, CHANNEL_DEFAULTS_KEY } from "./subjects.js";
import type { ChannelConfig, ChannelDefaults } from "./types.js";

/** The declarative channel-config file read at `cotal up` to seed the registry. */
export interface ChannelRegistryFile {
  defaults?: ChannelDefaults;
  /** Map of channel token → its config. */
  channels?: Record<string, ChannelConfig>;
}

/** Length caps on the model-facing registry text — unbounded text would stuff every agent's
 *  context and bloat the KV, so a write past these throws rather than clamps. */
export const MAX_CHANNEL_DESCRIPTION = 200;
export const MAX_CHANNEL_INSTRUCTIONS = 2000;

/** Throw if a config's text fields exceed their caps. A write past the cap is a caller bug,
 *  not data to clamp — fail loud so the oversize is fixed at the source. */
export function validateChannelConfig(cfg: ChannelConfig): void {
  if (cfg.description !== undefined && cfg.description.length > MAX_CHANNEL_DESCRIPTION)
    throw new Error(
      `channel description too long (${cfg.description.length} > ${MAX_CHANNEL_DESCRIPTION} chars)`,
    );
  if (cfg.instructions !== undefined && cfg.instructions.length > MAX_CHANNEL_INSTRUCTIONS)
    throw new Error(
      `channel instructions too long (${cfg.instructions.length} > ${MAX_CHANNEL_INSTRUCTIONS} chars)`,
    );
}

/** Effective replay-on-join policy for a channel: per-channel override ?? space default ??
 *  `true`. Default-true preserves Cotal's original always-replay behavior. */
export function effectiveReplay(
  cfg: ChannelConfig | undefined,
  defaults: ChannelDefaults | undefined,
): boolean {
  return cfg?.replay ?? defaults?.replay ?? true;
}

/** Open the channels registry bucket. Auth mode (creds present) OPENs the bucket pre-created
 *  at `cotal up`; open dev mode lazily CREATEs it. Mirrors the presence-bucket open/create
 *  split (and, like presence, agents are denied KV stream-create so they must OPEN). */
export async function openChannelRegistry(
  nc: NatsConnection,
  space: string,
  opts: { create?: boolean } = {},
): Promise<KV> {
  const kvm = new Kvm(nc);
  return opts.create ? kvm.create(channelBucket(space)) : kvm.open(channelBucket(space));
}

/** Read one channel's config (or undefined if unset/deleted). */
export async function readChannelConfig(
  kv: KV,
  channel: string,
): Promise<ChannelConfig | undefined> {
  return decode<ChannelConfig>(kv, channel);
}

/** Read the space-wide defaults (or undefined if unset). */
export async function readChannelDefaults(kv: KV): Promise<ChannelDefaults | undefined> {
  return decode<ChannelDefaults>(kv, CHANNEL_DEFAULTS_KEY);
}

/** Privileged write of a channel's config. **Merges** over any existing entry so a partial
 *  set (e.g. `--desc` only) doesn't wipe `replay`. Validated before the put. */
export async function writeChannelConfig(
  kv: KV,
  channel: string,
  patch: ChannelConfig,
): Promise<void> {
  validateChannelConfig(patch);
  const merged: ChannelConfig = { ...(await readChannelConfig(kv, channel)), ...patch };
  await kv.put(channel, JSON.stringify(merged));
}

/** Privileged write of the space-wide defaults (merged over any existing). */
export async function writeChannelDefaults(kv: KV, patch: ChannelDefaults): Promise<void> {
  const merged: ChannelDefaults = { ...(await readChannelDefaults(kv)), ...patch };
  await kv.put(CHANNEL_DEFAULTS_KEY, JSON.stringify(merged));
}

async function decode<T>(kv: KV, key: string): Promise<T | undefined> {
  const e = await kv.get(key);
  if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
  try {
    return e.json<T>();
  } catch {
    return undefined;
  }
}

/** Connect (with the given privileged creds, or open if none), seed the registry from a
 *  declarative {@link ChannelRegistryFile} (defaults + per-channel config, merged), disconnect.
 *  Used by `cotal up` to seed once at setup, and by `cotal channels` for runtime writes.
 *  Each field in the file overwrites that field in the registry; unspecified fields are kept. */
export async function seedChannelRegistry(opts: {
  servers: string;
  space: string;
  creds?: string;
  file: ChannelRegistryFile;
}): Promise<void> {
  const nc = await connect({
    servers: opts.servers,
    ...(opts.creds
      ? { authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)) }
      : {}),
  });
  try {
    // The seed path is privileged (manager creds or open) so it may CREATE the bucket — this
    // makes `cotal channels` work on a space whose bucket wasn't pre-created (e.g. one set up
    // before this feature). Idempotent when `cotal up` already created it.
    const kv = await openChannelRegistry(nc, opts.space, { create: true });
    if (opts.file.defaults) await writeChannelDefaults(kv, opts.file.defaults);
    for (const [channel, cfg] of Object.entries(opts.file.channels ?? {}))
      await writeChannelConfig(kv, channel, cfg);
  } finally {
    await nc.drain();
  }
}

/** Connect, read the whole registry (defaults + every channel entry) into a
 *  {@link ChannelRegistryFile}, disconnect. The read side of {@link seedChannelRegistry},
 *  used by `cotal channels list`. */
export async function readChannelRegistry(opts: {
  servers: string;
  space: string;
  creds?: string;
}): Promise<ChannelRegistryFile> {
  const nc = await connect({
    servers: opts.servers,
    ...(opts.creds
      ? { authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)) }
      : {}),
  });
  try {
    const kv = await openChannelRegistry(nc, opts.space, { create: true });
    const channels: Record<string, ChannelConfig> = {};
    let defaults: ChannelDefaults | undefined;
    for await (const key of await kv.keys()) {
      if (key === CHANNEL_DEFAULTS_KEY) {
        defaults = await readChannelDefaults(kv);
        continue;
      }
      const cfg = await readChannelConfig(kv, key);
      if (cfg) channels[key] = cfg;
    }
    return { defaults, channels };
  } finally {
    await nc.drain();
  }
}
