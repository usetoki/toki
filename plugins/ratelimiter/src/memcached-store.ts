import type { Store, StoreHit } from "./store.js";

/**
 * Minimal memcached surface. Modern memjs matches with a thin wrapper; the older
 * `memcached` package's callback API needs promisifying first. See the README.
 */
export interface MemcachedClient {
  /** Set only if the key is absent; resolves `true` on success, `false` if it exists. */
  add(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Atomic increment; resolves the new value, or `null` when the key is absent. */
  incr(key: string, amount: number): Promise<number | null>;
}

export interface MemcachedStoreOptions {
  client: MemcachedClient;
  /** Key prefix in the keyspace. Default `"trl:"`. */
  prefix?: string;
}

/**
 * {@link Store} backed by memcached. memcached can't report a key's remaining TTL, so
 * `resetAt` (and thus `Retry-After`) is the full window length — an upper bound, not the
 * exact time left. The counter itself still expires server-side at the real TTL.
 */
export class MemcachedStore implements Store {
  readonly #client: MemcachedClient;
  readonly #prefix: string;

  constructor(options: MemcachedStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "trl:";
  }

  async hit(key: string, windowMs: number): Promise<StoreHit> {
    const k = this.#prefix + key;
    const ttl = Math.max(1, Math.ceil(windowMs / 1000));
    const resetAt = Date.now() + windowMs;

    // incr is atomic but won't create a key; a miss means the window isn't open yet
    const current = await this.#client.incr(k, 1);
    if (current !== null) return { count: current, resetAt };

    // open the window. `add` is atomic, so a racing opener makes ours fail — re-incr then
    if (await this.#client.add(k, "1", ttl)) return { count: 1, resetAt };
    const raced = await this.#client.incr(k, 1);
    return { count: raced ?? 1, resetAt };
  }
}
