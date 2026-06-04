/**
 * A typed registry of extensions, keyed by `kind:name`. Implementations
 * **self-register** their extensions (connectors, commands …) as a side-effect of
 * import; composition roots just import the packages they want and then resolve.
 *
 * Core stays ignorant of which extensions exist: they plug into the registry, not
 * the other way round. An unknown extension throws — no silent fallback.
 */
export interface Extension {
  readonly kind: string;
  readonly name: string;
}

export class Registry {
  #byKey = new Map<string, Extension>();

  /** Register one or more extensions. A duplicate `kind:name` throws. */
  register(...exts: Extension[]): void {
    for (const ext of exts) {
      const key = `${ext.kind}:${ext.name}`;
      if (this.#byKey.has(key)) throw new Error(`extension already registered: ${key}`);
      this.#byKey.set(key, ext);
    }
  }

  /** Resolve one extension by kind + name. Unknown throws. */
  resolve<T extends Extension>(kind: T["kind"], name: string): T {
    const ext = this.#byKey.get(`${kind}:${name}`);
    if (!ext) throw new Error(`no ${kind} registered for "${name}"`);
    return ext as T;
  }

  /** Every registered extension of a kind (e.g. all commands, for CLI dispatch). */
  all<T extends Extension>(kind: T["kind"]): T[] {
    return [...this.#byKey.values()].filter((e) => e.kind === kind) as T[];
  }
}

/** The process-wide registry. Implementations self-register into it on import. */
export const registry = new Registry();
