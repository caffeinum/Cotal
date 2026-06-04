import type { Extension } from "./registry.js";

/** Identity + mesh coordinates the manager hands a connector to launch an agent. */
export interface LaunchOpts {
  space: string;
  name: string;
  role?: string;
  servers?: string;
}

/** A recipe for starting an agent as a mesh node — command, args, and extra env. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The first extension kind: a bridge that knows how to launch one agent type
 * (Claude Code, Codex, the CLI peer …) as a Swarl mesh node. `name` is the
 * agent type it handles — the key the manager resolves by.
 */
export interface Connector extends Extension {
  readonly kind: "connector";
  buildLaunch(opts: LaunchOpts): LaunchSpec;
}
