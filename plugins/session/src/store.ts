export type SessionData = Record<string, unknown>;

export interface SessionStore {
  get(sid: string): SessionData | null | Promise<SessionData | null>;
  set(sid: string, data: SessionData, ttlMs: number): void | Promise<void>;
  destroy(sid: string): void | Promise<void>;
  /** refresh a session's TTL without rewriting it (rolling sessions) */
  touch?(sid: string, ttlMs: number): void | Promise<void>;
}

interface Entry {
  data: SessionData;
  expiresAt: number;
}

/** In-process store; evicts expired sessions on a periodic sweep. Single process only —
 *  use a Redis or memcached store to share sessions across instances. */
export class MemoryStore implements SessionStore {
  readonly #sessions = new Map<string, Entry>();
  readonly #sweep: ReturnType<typeof setInterval>;
  // a client can mint a fresh session per request, so cap the table to bound memory
  readonly #maxKeys: number;

  constructor(sweepMs = 60_000, maxKeys = 100_000) {
    this.#maxKeys = maxKeys;
    this.#sweep = setInterval(() => this.#evict(), sweepMs);
    this.#sweep.unref?.();
  }

  get(sid: string): SessionData | null {
    const entry = this.#sessions.get(sid);
    if (entry === undefined) return null;
    if (Date.now() >= entry.expiresAt) {
      this.#sessions.delete(sid);
      return null;
    }
    // clone so two concurrent requests for the same session don't share — and mutate — one object
    return structuredClone(entry.data);
  }

  set(sid: string, data: SessionData, ttlMs: number): void {
    if (!this.#sessions.has(sid) && this.#sessions.size >= this.#maxKeys) this.#capacityEvict();
    this.#sessions.set(sid, { data: structuredClone(data), expiresAt: Date.now() + ttlMs });
  }

  destroy(sid: string): void {
    this.#sessions.delete(sid);
  }

  touch(sid: string, ttlMs: number): void {
    const entry = this.#sessions.get(sid);
    if (entry !== undefined) entry.expiresAt = Date.now() + ttlMs;
  }

  /** stop the sweep timer (call on shutdown / in tests) */
  close(): void {
    clearInterval(this.#sweep);
  }

  #evict(): void {
    const now = Date.now();
    for (const [sid, entry] of this.#sessions) {
      if (now >= entry.expiresAt) this.#sessions.delete(sid);
    }
  }

  // at capacity: drop expired first, then oldest-inserted (Map keeps order)
  #capacityEvict(): void {
    this.#evict();
    while (this.#sessions.size >= this.#maxKeys) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) break;
      this.#sessions.delete(oldest);
    }
  }
}
