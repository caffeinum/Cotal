import * as p from "@clack/prompts";
import { dim } from "./theme.js";
import { assistAvailable, runHandoff } from "./assist.js";
import type { SetupLog } from "./setup-log.js";

export interface Step {
  /** Slug used in the log and the Claude handoff prompt. */
  name: string;
  /** Human line shown while the step runs. */
  title: string;
  /** One-line plain-language narration shown before the step runs. */
  explain?: string;
  /** Ask before running (Y/n); a declined optional step is simply skipped. */
  optional?: boolean;
  /** Consent prompt shown (Y/n, default yes) before the step runs on a TTY; a "no"
   *  skips the step. Non-TTY runs without asking. For steps that change the user's
   *  system (e.g. installing the Claude Code plugin). */
  confirm?: string;
  /** The step draws its own live pane; the runner shows no spinner, just the result line. */
  live?: boolean;
  /** Paths/URLs Claude should read when this step fails. */
  context?: string[];
  /** Throw to fail; a returned string becomes the detail on the result line. */
  run(): Promise<string | void>;
}

/** Run steps in order with a failure loop per step: offer a Claude handoff, then
 *  retry / skip / quit. Returns false on abort.
 *
 *  `yes` is non-interactive accept-all (agents/CI): optional and `confirm` steps run
 *  without prompting (so e.g. demo agents are written), and a failure aborts with the
 *  log path instead of opening the recovery menu/handoff, even on a TTY. */
export async function runSteps(steps: Step[], log: SetupLog, opts: { yes?: boolean } = {}): Promise<boolean> {
  const interactive = process.stdin.isTTY && !opts.yes;
  for (const step of steps) {
    if (step.optional && !opts.yes && (!interactive || !(await ask(`${step.title}?`)))) {
      p.log.info(dim(`skipped: ${step.title}`));
      log.line(`${step.name}: skipped (declined)`);
      continue;
    }
    // Consent before a system-changing step (interactive only); a "no" skips it.
    if (step.confirm && interactive && !(await ask(step.confirm))) {
      p.log.info(dim(`skipped: ${step.title}`));
      log.line(`${step.name}: skipped (declined consent)`);
      continue;
    }
    if (!(await runOne(step, log, interactive))) return false;
  }
  return true;
}

async function runOne(step: Step, log: SetupLog, interactive: boolean): Promise<boolean> {
  for (;;) {
    if (step.explain) p.log.step(step.explain);
    const spin = step.live ? undefined : p.spinner();
    spin?.start(step.title);
    try {
      const detail = await step.run();
      const line = `${step.title}${detail ? dim(` · ${detail}`) : ""}`;
      if (spin) spin.stop(line);
      else p.log.success(line);
      log.line(`${step.name}: ok${detail ? ` · ${detail}` : ""}`);
      return true;
    } catch (e) {
      const err = e as Error;
      if (spin) spin.stop(`${step.title}: failed`);
      p.log.error(err.message);
      log.line(`${step.name}: FAILED · ${err.message}`);

      // Non-interactive (CI, piped, or --yes): no recovery loop; abort with the log path.
      if (!interactive) {
        p.log.message(dim(`See ${log.path}`));
        return false;
      }

      const choice = await failureMenu(step);
      if (choice === "debug") {
        await runHandoff({ step: step.name, error: err, context: step.context ?? [], logPath: log.path });
        continue;
      }
      if (choice === "retry") continue;
      if (choice === "skip") {
        if (!step.optional) {
          p.log.warn(`Setup can't continue without "${step.title}". Fix it and re-run: cotal setup`);
          return false;
        }
        log.line(`${step.name}: skipped (after failure)`);
        return true;
      }
      return false; // quit
    }
  }
}

type Choice = "retry" | "debug" | "skip" | "quit";

async function failureMenu(step: Step): Promise<Choice> {
  const options: { value: Choice; label: string }[] = [{ value: "retry", label: "Retry this step" }];
  if (assistAvailable()) options.push({ value: "debug", label: "Debug it with Claude" });
  options.push({ value: "skip", label: step.optional ? "Skip it" : "Skip (may abort)" });
  options.push({ value: "quit", label: "Quit setup" });
  const choice = await p.select({ message: "What now?", options });
  if (p.isCancel(choice)) return "quit";
  return choice as Choice;
}

async function ask(message: string): Promise<boolean> {
  const answer = await p.confirm({ message, initialValue: true });
  return p.isCancel(answer) ? false : answer;
}
