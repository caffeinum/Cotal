import { generateText, tool, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { MeshAgent, configFromEnv, FEEDBACK_CHANNEL } from "@swarl/core";
import type { InboxItem } from "@swarl/core";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";

/** Whole-word, case-insensitive mention check (so a short name like "ai" doesn't match "available"). */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

export async function runVercelAgentPeer(): Promise<void> {
  const mesh = new MeshAgent(configFromEnv());
  mesh.start();

  // Read-only/awareness tools. Replies are delivered by the loop (see processNext)
  // on the correct delivery mode, so the model can't mis-route or duplicate them.
  const tools = {
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
        "Reply with the answer itself as plain text; it is delivered automatically back to whoever messaged you. Be concise.",
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
          await mesh.dm(item.fromId, reply);
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
    if (item.kind === "channel" && item.channel === FEEDBACK_CHANNEL) return;
    // Channel messages: only respond when we're explicitly mentioned.
    if (item.kind === "channel" && !mentions(item.text, mesh.config.name)) return;
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
