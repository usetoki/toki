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
}

/** In-process idempotency store with a periodic sweep. */
export class MemoryStore implements IdempotencyStore {
  readonly #slots = new Map<string, Slot>();
  readonly #sweep: ReturnType<typeof setInterval>;

  constructor(options: MemoryStoreOptions = {}) {
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

  #evict(): void {
    const now = Date.now();
    for (const [key, slot] of this.#slots) {
      if (now >= slot.expiresAt) this.#slots.delete(key);
    }
  }
}
