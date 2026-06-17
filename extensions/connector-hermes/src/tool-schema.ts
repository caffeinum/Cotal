/**
 * Render the shared Cotal tool surface as Hermes plugin-tool descriptors.
 *
 * One source of truth: {@link cotalToolSpecs} (connector-core). We do NOT hand-write the Hermes
 * tool list — we generate `{name, description, parameters}` from each spec (Zod raw shape →
 * JSON Schema via Zod 4's `toJSONSchema`) so a Hermes peer gets exactly the same `cotal_*`
 * surface as Claude Code / OpenCode, and `parity.smoke.ts` fails if the two ever drift.
 *
 * The descriptors are written to a file the launcher hands the gateway (`COTAL_TOOLS_FILE`); the
 * Python plugin reads it at `register(ctx)` time so tool registration stays synchronous and never
 * has to block on the bridge. Tool *calls* still ride the bridge at runtime.
 */
import { z } from "zod";
import { cotalToolSpecs, type AgentConfig } from "@cotal-ai/connector-core";

/** A Hermes plugin tool: name + description + a JSON-Schema object for its parameters. */
export interface HermesToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const EMPTY_PARAMS: Record<string, unknown> = { type: "object", properties: {}, required: [] };

/** cotal_inbox is read-only under a driven connector: this connector surfaces each batch into a
 *  turn and acks on completion, so the agent's inbox tool must PEEK, never drain (a drain would
 *  race the connector's ack). Mirror the OpenCode connector's read-only framing. */
const READONLY_INBOX_DESCRIPTION =
  "Show the peer messages currently waiting for you (incl. focus-mode recall). You don't normally " +
  "need this — peer messages are delivered into your turns automatically; use it to re-check " +
  "what's pending mid-task. Read-only: it never consumes them.";

/** Build the Hermes tool descriptors for a given agent config (rendered from the shared specs). */
export function hermesToolDescriptors(config: AgentConfig): HermesToolDescriptor[] {
  return cotalToolSpecs(config, "hermes").map((spec) => {
    if (spec.name === "cotal_inbox") {
      return { name: spec.name, description: READONLY_INBOX_DESCRIPTION, parameters: EMPTY_PARAMS };
    }
    const parameters = spec.schema
      ? (z.toJSONSchema(z.object(spec.schema)) as Record<string, unknown>)
      : EMPTY_PARAMS;
    return { name: spec.name, description: spec.description, parameters };
  });
}
