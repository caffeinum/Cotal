import type { Extension } from "./registry.js";

/** Identity + mesh coordinates the manager hands a connector to launch an agent. */
export interface LaunchOpts {
  space: string;
  name: string;
  role?: string;
  servers?: string;
  /** Path to an agent definition file (`.swarl/agents/<name>.md`). The connector
   *  passes it through (`SWARL_AGENT_FILE`) so the joined session reads its own
   *  card from it, and applies the file's persona/model at launch. */
  configPath?: string;
}

/** A recipe for starting an agent as a mesh node — command, args, and extra env. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Auto-clear a one-time spawn prompt: when this text appears in the agent's
   *  early output, the runtime presses Enter once so a supervised launch stays
   *  non-interactive. Matched after stripping ANSI + whitespace (TUIs position
   *  text with cursor moves, not spaces). */
  confirm?: string;
}

/**
 * A bridge that knows how to launch one agent type (Claude Code, Codex, the CLI
 * peer …) as a Swarl mesh node — an {@link Extension} of kind `"connector"`.
 * `name` is the agent type it handles — the key the manager resolves by.
 * Connectors self-register on import; the manager resolves them from the registry,
 * and core stays ignorant of which ones exist.
 */
export interface Connector extends Extension {
  readonly kind: "connector";
  readonly name: string;
  buildLaunch(opts: LaunchOpts): LaunchSpec;
}
