/**
 * The mesh-manifest schema (`cotal.yaml`, `kind: Mesh`) — the strict Zod shape the parser
 * validates before any normalization. Strict objects reject unknown keys (no silent ignore —
 * matches the repo's "no fallbacks" rule); the resolved/inverted model lives in {@link ./model.js}.
 *
 * This is shape-only: cross-field rules (names resolve to an agent, `allowSubscribe ⊇ subscribe`,
 * concrete channel tokens) are pure semantic checks in {@link ./resolve.js}, where they can report
 * the offending file + line.
 */
import { z } from "zod";

const DeliveryClass = z.enum(["live", "durable"]);
const PersonaPermissions = z.enum(["reject", "include"]);

/** An `agents:` value is a string (a bare persona path) OR an object — either an override on a
 *  persona file (`persona:` present) or a fully inline agent (no `persona:`). One object schema
 *  covers both; {@link ./resolve.js} splits them on the presence of `persona`. */
const AgentEntryObject = z
  .strictObject({
    persona: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    /** Per-agent override of the top-level `personaPermissions` policy. */
    personaPermissions: PersonaPermissions.optional(),
  })
  .refine((v) => v.persona !== undefined || v.model !== undefined || v.instructions !== undefined, {
    message:
      "inline agent (no `persona:`) needs at least `model` or `instructions` — otherwise reference a persona file",
  });

const AgentEntry = z.union([z.string().min(1), AgentEntryObject]);

/** A channel carries its registry card (description/instructions + replay knobs — the existing
 *  ChannelConfig fields) plus the three native access verbs listed per-channel (agents under it). */
const ChannelEntry = z.strictObject({
  description: z.string().optional(),
  instructions: z.string().optional(),
  subscribe: z.array(z.string().min(1)).optional(),
  allowSubscribe: z.array(z.string().min(1)).optional(),
  allowPublish: z.array(z.string().min(1)).optional(),
  replay: z.boolean().optional(),
  replayWindow: z.string().optional(),
  deliveryClass: DeliveryClass.optional(),
});

const Defaults = z.strictObject({
  replay: z.boolean().optional(),
  replayWindow: z.string().optional(),
  deliveryClass: DeliveryClass.optional(),
});

const Broker = z.strictObject({
  servers: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  auth: z.boolean().optional(),
});

/** The whole manifest. `apiVersion`/`kind` are literals so a foreign YAML doc is rejected up front;
 *  `agents` and `channels` are required maps. */
export const MeshManifestSchema = z.strictObject({
  apiVersion: z.literal("cotal/v1"),
  kind: z.literal("Mesh"),
  space: z.string().min(1),
  broker: Broker.optional(),
  runtime: z.enum(["pty", "tmux", "cmux"]).optional(),
  personaPermissions: PersonaPermissions.optional(),
  agents: z.record(z.string().min(1), AgentEntry),
  defaults: Defaults.optional(),
  channels: z.record(z.string().min(1), ChannelEntry),
});

export type RawManifest = z.infer<typeof MeshManifestSchema>;
export type RawAgentEntry = z.infer<typeof AgentEntry>;
export type RawChannelEntry = z.infer<typeof ChannelEntry>;
