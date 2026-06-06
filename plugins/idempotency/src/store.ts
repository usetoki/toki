/** A captured response, enough to replay it byte-for-byte on a retry. */
export interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
}

/** Outcome of reserving a key: a fresh slot, a replayable record, a live request, or a clash. */
export type BeginResult =
  | { readonly state: "new" }
  | { readonly state: "replay"; readonly record: IdempotencyRecord }
  | { readonly state: "in-flight" }
  | { readonly state: "mismatch" };

/**
 * Where idempotency state lives. `begin` atomically reserves a key (so two concurrent
 * retries can't both run) under a short *lock* TTL; `complete` swaps the reservation for
 * the finished record under a long *record* TTL; `release` drops a reservation early.
 */
export interface IdempotencyStore {
  begin(key: string, fingerprint: string, lockTtlMs: number): BeginResult | Promise<BeginResult>;
  complete(key: string, record: IdempotencyRecord, ttlMs: number): void | Promise<void>;
  release(key: string): void | Promise<void>;
}

interface Slot {
  fingerprint: string;
  record: IdempotencyRecord | null;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  /** Interval to sweep expired slots, ms. Default `60000`. */
  sweepMs?: number;
  /** Hard ceiling on stored keys. Default `100000`. The Idempotency-Key is attacker-
   *  controlled, so without a cap a flood of unique keys grows memory until their TTL. */
  maxKeys?: number;
}

/** In-process idempotency store with a periodic sweep. */
export class MemoryStore implements IdempotencyStore {
  readonly #slots = new Map<string, Slot>();
  readonly #sweep: ReturnType<typeof setInterval>;
  readonly #maxKeys: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.#maxKeys = options.maxKeys ?? 100_000;
    this.#sweep = setInterval(() => this.#evict(), options.sweepMs ?? 60_000);
    this.#sweep.unref?.();
  }

  begin(key: string, fingerprint: string, lockTtlMs: number): BeginResult {
    const slot = this.#slots.get(key);
    if (slot !== undefined && Date.now() < slot.expiresAt) {
      if (slot.fingerprint !== fingerprint) return { state: "mismatch" };
      return slot.record !== null
        ? { state: "replay", record: slot.record }
        : { state: "in-flight" };
    }
    if (this.#slots.size >= this.#maxKeys) this.#capacityEvict();
    this.#slots.set(key, { fingerprint, record: null, expiresAt: Date.now() + lockTtlMs });
    return { state: "new" };
  }

  complete(key: string, record: IdempotencyRecord, ttlMs: number): void {
    this.#slots.set(key, {
      fingerprint: record.fingerprint,
      record,
      expiresAt: Date.now() + ttlMs,
    });
  }

  release(key: string): void {
    this.#slots.delete(key);
  }

  close(): void {
    clearInterval(this.#sweep);
  }

  /** Live slot count — bounded by maxKeys. */
  get size(): number {
    return this.#slots.size;
  }

  #evict(): void {
    const now = Date.now();
    for (const [key, slot] of this.#slots) {
      if (now >= slot.expiresAt) this.#slots.delete(key);
    }
  }

  // at capacity: drop expired first, then oldest-inserted (Map keeps order) so a flood
  // of unique keys can never push the table past the ceiling.
  #capacityEvict(): void {
    this.#evict();
    while (this.#slots.size >= this.#maxKeys) {
      const oldest = this.#slots.keys().next().value;
      if (oldest === undefined) break;
      this.#slots.delete(oldest);
    }
  }
}
