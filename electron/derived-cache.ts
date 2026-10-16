// Results a view asks for again and again (Home, Discover, Mixes), kept until
// the library changes. Every entry carries the library version it was computed
// at and is only served at that same version, so there is no list of writes to
// keep in step with it: whatever moves the version drops everything.
export class DerivedCache {
  private readonly entries = new Map<string, { version: number; value: unknown }>();
  private readonly running = new Map<string, { version: number; promise: Promise<unknown> }>();

  constructor(private readonly maxEntries = 48) {}

  get<T>(key: string, version: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.version !== version) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so the entry counts as recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set(key: string, version: number, value: unknown): void {
    this.entries.delete(key);
    this.entries.set(key, { version, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * The cached value, or the result of a computation already running for this
   * key at this version, or a new one. A result is only kept if the library
   * did not change while it was being computed; the caller still gets it.
   */
  async resolve<T>(key: string, currentVersion: () => number, compute: () => Promise<T>): Promise<T> {
    const version = currentVersion();
    const hit = this.get<T>(key, version);
    if (hit !== undefined) return hit;
    const joined = this.running.get(key);
    if (joined && joined.version === version) return joined.promise as Promise<T>;
    const promise: Promise<T> = compute()
      .then((value) => {
        if (currentVersion() === version) this.set(key, version, value);
        return value;
      })
      .finally(() => {
        if (this.running.get(key)?.promise === promise) this.running.delete(key);
      });
    this.running.set(key, { version, promise });
    return promise;
  }

  /** Frees what is kept; computations under way are left to finish and are not kept either. */
  dropKept(): void {
    this.entries.clear();
  }
}
