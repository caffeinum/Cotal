import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { MeshAgent, configFromEnv } from "@swarl/core";
import type { InboxItem } from "@swarl/core";

const DEFAULT_MODEL = "gpt-4o-mini";

function buildTools(mesh: MeshAgent) {
  const swarl_send = tool({
    name: "swarl_send",
    description: "Broadcast a message to a channel on the Swarl mesh.",
    parameters: z.object({
      text: z.string().describe("Message text"),
      channel: z.string().optional().describe("Channel name; defaults to general"),
    }),
    execute: async ({ text, channel }) => {
      await mesh.send(text, channel);
      return `sent to #${channel ?? "general"}`;
    },
  });

  const swarl_dm = tool({
    name: "swarl_dm",
    description: "Send a direct message to a named peer on the Swarl mesh.",
    parameters: z.object({
      to: z.string().describe("Peer name or id"),
      text: z.string().describe("Message text"),
    }),
    execute: async ({ to, text }) => {
      await mesh.dm(to, text);
      return `dm sent to ${to}`;
    },
  });

  const swarl_anycast = tool({
    name: "swarl_anycast",
    description: "Send a message to any one peer with a given role on the Swarl mesh.",
    parameters: z.object({
      role: z.string().describe("Target role"),
      text: z.string().describe("Message text"),
    }),
    execute: async ({ role, text }) => {
      await mesh.anycast(role, text);
      return `anycast sent to role "${role}"`;
    },
  });

  const swarl_roster = tool({
    name: "swarl_roster",
    description: "List peers currently present on the Swarl mesh.",
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

  return [swarl_send, swarl_dm, swarl_anycast, swarl_roster, swarl_status];
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
      "Answer concisely. Use the swarl_* tools to communicate with other peers when needed.",
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
      const output = typeof result.finalOutput === "string"
        ? result.finalOutput
        : JSON.stringify(result.finalOutput);
      if (item.kind === "channel") {
        await mesh.send(output, item.channel);
      } else {
        await mesh.dm(item.fromName, output);
      }
    } catch (e) {
      process.stderr.write(`[openai-peer] error handling item: ${(e as Error).message}\n`);
    } finally {
      await mesh.setStatus("idle");
      running = false;
      void processNext();
    }
  }

  const FEEDBACK_CHANNEL = "feedback";

  mesh.on("incoming", (item: InboxItem) => {
    // Drop our own echoes.
    if (item.fromId === mesh.id) return;
    // Ignore feedback channel.
    if (item.kind === "channel" && item.channel === FEEDBACK_CHANNEL) return;
    // For channel messages, only respond when mentioned by name.
    if (item.kind === "channel") {
      const name = mesh.config.name.toLowerCase();
      if (!item.text.toLowerCase().includes(name)) return;
    }
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
