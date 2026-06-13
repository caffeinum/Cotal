import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as p from "@clack/prompts";
import { dim } from "./theme.js";

export interface AssistContext {
  /** Failed step slug (as shown to the user and written to the log). */
  step: string;
  error: Error;
  /** Local paths and doc URLs Claude should read for context — referenced in the
   *  prompt, never inlined, so it works without a repo clone. */
  context: string[];
  logPath: string;
}

/** Interactive Claude is offered only when it can actually run: a TTY, the
 *  `claude` binary on PATH, and not opted out via COTAL_SKIP_ASSIST=1 (CI). */
export function assistAvailable(): boolean {
  if (process.env.COTAL_SKIP_ASSIST === "1") return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

// All handoffs in one setup run share a single Claude session: the first spawn pins
// a generated UUID (--session-id), later spawns --resume it — so Claude keeps the
// context of earlier failures. stdio is inherited, so pinning our own id is the only
// way to find the session again.
let sessionId: string | undefined;

/** Hand the terminal to an interactive Claude session primed with the failure
 *  context. Resolves when the user exits Claude (/exit) and setup resumes. */
export async function runHandoff(ctx: AssistContext): Promise<void> {
  const sessionArgs = sessionId ? ["--resume", sessionId] : ["--session-id", (sessionId = randomUUID())];
  p.note(
    `Failed step: ${ctx.step}\n${ctx.error.message}\n\nType ${dim("/exit")} when you're done — setup resumes here.`,
    "Handing off to Claude",
  );
  const child = spawn("claude", [buildPrompt(ctx), "--permission-mode", "auto", ...sessionArgs], {
    stdio: "inherit",
  });
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => {
      p.log.error("Couldn't launch Claude — continuing without it.");
      resolve();
    });
  });
  p.log.info("Back from Claude.");
}

function buildPrompt(ctx: AssistContext): string {
  return [
    "I'm running `cotal setup` (Cotal: a mesh where AI agents coordinate as lateral",
    "peers over NATS/JetStream) and a setup step failed. Help me diagnose and fix it.",
    "",
    `Failed step: ${ctx.step}`,
    `Error: ${ctx.error.message}`,
    "",
    "Read these for context as needed (don't assume their contents):",
    ...[ctx.logPath, ...ctx.context].map((f) => `  - ${f}`),
    "",
    "Be concise. When the issue is fixed, remind me to type /exit — I'll land back",
    "in the setup flow, which will offer to retry the failed step.",
  ].join("\n");
}
