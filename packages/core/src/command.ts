import type { Extension } from "./registry.js";

/**
 * The contract for a composable CLI command — an {@link Extension} of kind
 * `"command"`. An implementation (the mesh CLI, the manager …) self-registers its
 * commands on import; the `cotal` binary resolves them from the registry.
 */
export interface Command extends Extension {
  readonly kind: "command";
  readonly name: string;
  readonly summary: string;
  /** Help grouping header (e.g. "Mesh", "Control plane"). Defaults to "Commands". */
  readonly group?: string;
  run(argv: string[]): Promise<void>;
}
