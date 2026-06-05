/** One counter read: hits so far in the window, and when it resets (epoch ms). */
export interface StoreHit {
  readonly count: number;
  readonly resetAt: number;
}

/**
 * Backing store for {@link rateLimit}. The default is an in-process {@link MemoryStore};
 * implement this against Redis (or similar) to share counters across instances.
 */
export interface Store {
  /** Count one hit against `key` and return the running total + window reset. */
  hit(key: string, windowMs: number): StoreHit | Promise<StoreHit>;
  /** Optionally drop a key's counter (e.g. to refund a request you decided not to count). */
  reset?(key: string): void | Promise<void>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-process fixed-window counter. Each limiter gets its own store by default, so
 * buckets stay isolated per route. A periodic sweep evicts expired buckets, so memory
 * tracks active clients rather than every key ever seen.
 */
export class MemoryStore implements Store {
  readonly #buckets = new Map<string, Bucket>();
  readonly #sweep: ReturnType<typeof setInterval>;

  constructor(sweepMs = 60_000) {
    this.#sweep = setInterval(() => this.#evict(), sweepMs);
    // don't keep the process alive just for the sweep
    this.#sweep.unref?.();
  }

  hit(key: string, windowMs: number): StoreHit {
    const now = Date.now();
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      const fresh: Bucket = { count: 1, resetAt: now + windowMs };
      this.#buckets.set(key, fresh);
      return fresh;
    }
    bucket.count += 1;
    return bucket;
  }

  reset(key: string): void {
    this.#buckets.delete(key);
  }

  /** Stop the sweep timer. Call on shutdown (or in tests) to release it. */
  close(): void {
    clearInterval(this.#sweep);
  }

  #evict(): void {
    const now = Date.now();
    for (const [key, bucket] of this.#buckets) {
      if (now >= bucket.resetAt) this.#buckets.delete(key);
    }
  }
}
