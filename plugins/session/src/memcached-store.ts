import type { SessionData, SessionStore } from "./store.js";

/** Minimal memcached surface. Modern memjs matches with a thin wrapper; see the README. */
export interface MemcachedClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MemcachedStoreOptions {
  client: MemcachedClient;
  /** key prefix in the keyspace. Default `"sess:"`. */
  prefix?: string;
}

/** {@link SessionStore} backed by memcached. The server expires entries at the TTL. */
export class MemcachedStore implements SessionStore {
  readonly #client: MemcachedClient;
  readonly #prefix: string;

  constructor(options: MemcachedStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "sess:";
  }

  async get(sid: string): Promise<SessionData | null> {
    const raw = await this.#client.get(this.#prefix + sid);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  async set(sid: string, data: SessionData, ttlMs: number): Promise<void> {
    await this.#client.set(
      this.#prefix + sid,
      JSON.stringify(data),
      Math.max(1, Math.ceil(ttlMs / 1000)),
    );
  }

  async destroy(sid: string): Promise<void> {
    await this.#client.delete(this.#prefix + sid);
  }
}
