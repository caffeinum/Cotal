import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { c } from "../ui.js";

/** Walk up to the cotal repo root (where the plugin marketplace manifest lives). */
function repoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".claude-plugin", "marketplace.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("couldn't find the cotal repo root (.claude-plugin/marketplace.json)");
    dir = parent;
  }
}

/** Capture a command's stdout (for idempotency checks). */
function read(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * One-time onboarding: make the repo's Claude sessions cotal-aware by installing the
 * cotal plugin (the `cotal_*` tools + presence hooks). Idempotent — safe to re-run.
 * `cotal cmux go` runs this for you; you can also run it standalone.
 */
export async function setup(): Promise<void> {
  const root = repoRoot();

  // 1) The installed plugin runs the bundled dist/*.cjs — make sure it's built.
  const bundle = join(root, "extensions", "connector-claude-code", "dist", "mcp.cjs");
  if (!existsSync(bundle)) {
    console.log(c.dim("Building the connector bundle…"));
    execFileSync("pnpm", ["--filter", "@cotal/connector-claude-code", "bundle"], {
      cwd: root,
      stdio: "inherit",
    });
  }

  // 2) Register the cotal-mesh marketplace (+ install the plugin) via Claude Code's CLI.
  let marketplaces: string;
  try {
    marketplaces = read("claude", ["plugin", "marketplace", "list"]);
  } catch (e) {
    console.error(c.red("Couldn't run `claude` — is Claude Code installed and on your PATH?"));
    console.error(c.dim("Once it is, run these two commands manually:"));
    console.error(c.dim(`  claude plugin marketplace add ${root}`));
    console.error(c.dim("  claude plugin install cotal@cotal-mesh --scope local"));
    throw e;
  }
  if (!/\bcotal-mesh\b/.test(marketplaces)) {
    console.log(c.dim("Registering the cotal-mesh marketplace…"));
    execFileSync("claude", ["plugin", "marketplace", "add", root], { stdio: "inherit" });
  }

  // 3) Install the plugin (repo-local scope) if it isn't already.
  if (/\bcotal@cotal-mesh\b/.test(read("claude", ["plugin", "list"]))) {
    console.log(c.green("✓ cotal plugin already set up"));
    return;
  }
  console.log(c.dim("Installing the cotal plugin…"));
  execFileSync("claude", ["plugin", "install", "cotal@cotal-mesh", "--scope", "local"], {
    stdio: "inherit",
  });
  console.log(
    c.green("✓ cotal plugin installed — Claude sessions in this repo now have the cotal tools"),
  );
}
