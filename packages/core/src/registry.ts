/**
 * A typed registry of extensions, keyed by `kind:name`. The composition root
 * (an example) explicitly registers the extensions it wants; everything else
 * resolves them by kind + name. An unknown extension throws — no silent fallback.
 *
 * Core stays ignorant of which extensions exist: they plug into the registry,
 * not the other way round.
 */
export interface Extension {
  readonly kind: string;
  readonly name: string;
}

export class Registry {
  #byKey = new Map<string, Extension>();

  register(ext: Extension): void {
    const key = `${ext.kind}:${ext.name}`;
    if (this.#byKey.has(key)) throw new Error(`extension already registered: ${key}`);
    this.#byKey.set(key, ext);
  }

  resolve<T extends Extension>(kind: T["kind"], name: string): T {
    const ext = this.#byKey.get(`${kind}:${name}`);
    if (!ext) throw new Error(`no ${kind} registered for "${name}"`);
    return ext as T;
  }
}
