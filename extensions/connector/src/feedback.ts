import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { FeedbackDomain, FeedbackReport, FeedbackSeverity, FeedbackSource } from "@swarl/core";

export interface Origin {
  domain: FeedbackDomain;
  component: string;
}

/**
 * Classify where feedback originates by walking up from `cwd` to the nearest
 * package.json: a package under `packages/` is the protocol, anything else
 * (extensions, implementations, examples, …) is an implementation. The package
 * `name` becomes the component. Falls back to implementation / "unknown".
 */
export function classifyOrigin(cwd: string): Origin {
  let dir = cwd;
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      let component = dir.split(sep).pop() || "unknown";
      try {
        const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name;
        if (name) component = name;
      } catch {
        /* unreadable package.json — keep the directory name */
      }
      const domain: FeedbackDomain = dir.split(sep).includes("packages")
        ? "protocol"
        : "implementation";
      return { domain, component };
    }
    const parent = dirname(dir);
    if (parent === dir) return { domain: "implementation", component: "unknown" };
    dir = parent;
  }
}

/** Build a {@link FeedbackReport}, auto-deriving domain/component from `cwd`. */
export function buildReport(input: {
  message: string;
  source: FeedbackSource;
  severity?: FeedbackSeverity;
  meta?: Record<string, unknown>;
  cwd?: string;
}): FeedbackReport {
  const { domain, component } = classifyOrigin(input.cwd ?? process.cwd());
  return {
    source: input.source,
    domain,
    component,
    severity: input.severity ?? "info",
    message: input.message,
    meta: input.meta,
  };
}
