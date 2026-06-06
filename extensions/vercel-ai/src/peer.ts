import { generateText, tool, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { MeshAgent, configFromEnv } from "@swarl/core";
import type { InboxItem } from "@swarl/core";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";

export async function runVercelAgentPeer(): Promise<void> {
  const mesh = new MeshAgent(configFromEnv());
  mesh.start();

  const tools = {
    swarl_send: tool({
      description: "Send a message to a channel (multicast).",
      inputSchema: z.object({
        text: z.string().describe("Message text"),
        channel: z.string().optional().describe("Channel name; defaults to the peer's primary channel"),
      }),
      execute: async ({ text, channel }) => {
        await mesh.send(text, channel);
        return `sent to channel ${channel ?? "general"}`;
      },
    }),
    swarl_dm: tool({
      description: "Send a direct message to a named peer.",
      inputSchema: z.object({
        to: z.string().describe("Peer name or instance id"),
        text: z.string().describe("Message text"),
      }),
      execute: async ({ to, text }) => {
        await mesh.dm(to, text);
        return `dm sent to ${to}`;
      },
    }),
    swarl_anycast: tool({
      description: "Send a message to any one peer with a given role (anycast).",
      inputSchema: z.object({
        role: z.string().describe("Target role"),
        text: z.string().describe("Message text"),
      }),
      execute: async ({ role, text }) => {
        await mesh.anycast(role, text);
        return `anycast sent to role ${role}`;
      },
    }),
    swarl_roster: tool({
      description: "List all peers currently on the mesh.",
      inputSchema: z.object({}),
      execute: async () => {
        const peers = mesh.roster();
        if (peers.length === 0) return "roster is empty";
        return peers
          .map((p) => `${p.card.name}${p.card.role ? `/${p.card.role}` : ""} (${p.status})`)
          .join(", ");
      },
    }),
    swarl_status: tool({
      description: "Update this peer's presence status.",
      inputSchema: z.object({
        status: z.enum(["idle", "waiting", "working"]).describe("New status"),
        activity: z.string().optional().describe("Freeform activity description"),
      }),
      execute: async ({ status, activity }) => {
        await mesh.setStatus(status, activity);
        return `status set to ${status}`;
      },
    }),
  };

  // Serialized worker: one item at a time, never concurrent.
  const queue: InboxItem[] = [];
  let running = false;

  async function processNext(): Promise<void> {
    if (running || queue.length === 0) return;
    running = true;
    const item = queue.shift()!;
    try {
      await mesh.setStatus("working", `responding to ${item.fromName}`);

      const context = `from ${item.fromName} via ${item.kind}`;
      const prompt = [
        "You are a peer on a Swarl mesh — a shared pub/sub space where AI agents coordinate as lateral equals.",
        "Answer concisely and directly. Use the swarl_* tools only when explicitly needed.",
        "",
        `[${context}]`,
        item.text,
      ].join("\n");

      const result = await generateText({
        model: openai(MODEL),
        tools,
        stopWhen: stepCountIs(5),
        prompt,
      });

      const reply = result.text.trim();
      if (reply) {
        if (item.kind === "channel") {
          await mesh.send(reply, item.channel);
        } else {
          await mesh.dm(item.fromName, reply);
        }
      }
    } catch (e) {
      process.stderr.write(`[vercel-ai] error handling item: ${(e as Error).message}\n`);
    } finally {
      await mesh.setStatus("idle");
      running = false;
      void processNext();
    }
  }

  mesh.on("incoming", (item: InboxItem) => {
    // Skip our own echoes.
    if (item.fromId === mesh.id) return;
    // Ignore the feedback channel.
    if (item.kind === "channel" && item.channel === "feedback") return;
    // Channel messages: only respond when we're explicitly mentioned.
    if (item.kind === "channel") {
      const name = mesh.config.name.toLowerCase();
      if (!item.text.toLowerCase().includes(name)) return;
    }
    queue.push(item);
    void processNext();
  });

  mesh.on("error", (e: Error) => {
    process.stderr.write(`[vercel-ai] mesh error: ${e.message}\n`);
  });

  // Keep the process alive.
  const shutdown = () => {
    void mesh.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}
