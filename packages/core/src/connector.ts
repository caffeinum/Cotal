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
 * A bridge that knows how to launch one agent type (Claude Code, Codex, the CLI
 * peer …) as a Swarl mesh node. `name` is the agent type it handles — the key the
 * manager resolves by. Connectors are picked at a composition root and handed to
 * the manager; core stays ignorant of which ones exist.
 */
export interface Connector {
  readonly name: string;
  buildLaunch(opts: LaunchOpts): LaunchSpec;
}
