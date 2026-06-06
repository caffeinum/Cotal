import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { MeshAgent, configFromEnv, FEEDBACK_CHANNEL } from "@swarl/core";
import type { InboxItem } from "@swarl/core";

const DEFAULT_MODEL = "gpt-4o-mini";

/** Whole-word, case-insensitive mention check (so a short name like "ai" doesn't match "available"). */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/**
 * Read-only/awareness tools. Replies are NOT sent by the model — the run loop
 * delivers the agent's final text on the right delivery mode (see processNext),
 * so the model can't mis-route or duplicate a reply. These tools just let it see
 * who is present and report its own status.
 */
function buildTools(mesh: MeshAgent) {
  const swarl_roster = tool({
    name: "swarl_roster",
    description: "List the peers currently present on the Swarl mesh.",
    parameters: z.object({}),
    execute: async () => {
      const peers = mesh.roster();
      if (!peers.length) return "roster is empty";
      return peers
        .map((p) => `${p.card.name}${p.card.role ? `/${p.card.role}` : ""} [${p.status}]`)
        .join("\n");
    },
  });

  const swarl_status = tool({
    name: "swarl_status",
    description: "Update this peer's presence status on the mesh.",
    parameters: z.object({
      status: z.enum(["idle", "waiting", "working"]).describe("Presence status"),
      activity: z.string().optional().describe("Optional freeform activity description"),
    }),
    execute: async ({ status, activity }) => {
      await mesh.setStatus(status, activity);
      return `status set to ${status}`;
    },
  });

  return [swarl_roster, swarl_status];
}

export async function runOpenAIAgentPeer(): Promise<void> {
  const mesh = new MeshAgent(configFromEnv());
  mesh.start();

  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  const agent = new Agent({
    name: mesh.config.name,
    model,
    instructions:
      "You are a peer on a Swarl mesh — a shared pub/sub space where agents coordinate laterally. " +
      "Reply with the answer itself as plain text; it is delivered automatically back to whoever " +
      "messaged you. Be concise. Call swarl_roster if you need to see who is present.",
    tools: buildTools(mesh),
  });

  // Serialised queue: one item handled at a time.
  const queue: InboxItem[] = [];
  let running = false;

  async function processNext(): Promise<void> {
    if (running || queue.length === 0) return;
    running = true;
    const item = queue.shift()!;
    try {
      await mesh.setStatus("working", `handling ${item.kind} from ${item.fromName}`);
      const prefix = `from ${item.fromName} via ${item.kind}: `;
      const result = await run(agent, prefix + item.text);
      const output =
        typeof result.finalOutput === "string"
          ? result.finalOutput
          : JSON.stringify(result.finalOutput);
      if (output) {
        if (item.kind === "channel") {
          await mesh.send(output, item.channel);
        } else {
          await mesh.dm(item.fromId, output);
        }
      }
    } catch (e) {
      process.stderr.write(`[openai-peer] error handling item: ${(e as Error).message}\n`);
    } finally {
      await mesh.setStatus("idle");
      running = false;
      void processNext();
    }
  }

  mesh.on("incoming", (item: InboxItem) => {
    // Drop our own echoes.
    if (item.fromId === mesh.id) return;
    // Ignore feedback channel.
    if (item.kind === "channel" && item.channel === FEEDBACK_CHANNEL) return;
    // For channel messages, only respond when mentioned by name.
    if (item.kind === "channel" && !mentions(item.text, mesh.config.name)) return;
    queue.push(item);
    void processNext();
  });

  function shutdown() {
    mesh.stop().then(() => process.exit(0)).catch(() => process.exit(1));
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive.
  await new Promise<void>(() => {});
}
