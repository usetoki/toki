/** A cached response: enough to replay it byte-for-byte. Bodies are stored as bytes. */
export interface CacheEntry {
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  /** extra response headers to replay (e.g. `ETag`, `Location`); never `Set-Cookie`. */
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly vary?: string;
  /** epoch ms when it was cached (drives the `Age` header). */
  readonly storedAt: number;
  /** epoch ms when it expires. */
  readonly expiresAt: number;
}

/**
 * Where cached responses live. The default is an in-process {@link MemoryStore};
 * implement this over Redis (or anything) to share a cache across instances.
 */
export interface CacheStore {
  get(key: string): CacheEntry | null | Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry, ttlMs: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

export interface MemoryStoreOptions {
  /** Hard cap on entries; the oldest is evicted past it. Default `1000`. */
  max?: number;
  /** Interval to sweep expired entries, ms. Default `60000`. */
  sweepMs?: number;
}

/**
 * In-process cache with a bounded size and a periodic sweep, so memory tracks live
 * entries rather than growing without limit. Writes move a key to the newest slot;
 * past `max`, the least-recently-written key is dropped.
 */
export class MemoryStore implements CacheStore {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #max: number;
  readonly #sweep: ReturnType<typeof setInterval>;

  constructor(options: MemoryStoreOptions = {}) {
    this.#max = options.max ?? 1000;
    this.#sweep = setInterval(() => this.#evict(), options.sweepMs ?? 60_000);
    this.#sweep.unref?.();
  }

  get(key: string): CacheEntry | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    if (Date.now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return null;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry); // bump to newest so eviction is LRU, not least-recently-written
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.#entries.delete(key); // re-insert so it counts as the newest
    this.#entries.set(key, entry);
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  /** Stop the sweep timer. Call on shutdown (or in tests). */
  close(): void {
    clearInterval(this.#sweep);
  }

  #evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(key);
    }
  }
}
