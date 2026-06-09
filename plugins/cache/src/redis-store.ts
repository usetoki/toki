import type { CacheEntry, CacheStore } from "./store.js";

/** Minimal ioredis-compatible surface (also KeyDB / Valkey / Upstash). */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
}

export interface RedisStoreOptions {
  client: RedisClient;
  /** Key prefix in the keyspace. Default `"cache:"`. */
  prefix?: string;
}

// Compact JSON envelope. Body rides as base64 so binary survives the round trip; the
// server's PX TTL expires the key in lockstep with the entry.
interface Wire {
  s: number;
  c: string;
  b: string;
  h?: ReadonlyArray<readonly [string, string]>;
  v?: string;
  t: number;
  e: number;
}

/** {@link CacheStore} backed by Redis, so cached responses are shared across instances. */
export class RedisStore implements CacheStore {
  readonly #client: RedisClient;
  readonly #prefix: string;

  constructor(options: RedisStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "cache:";
  }

  async get(key: string): Promise<CacheEntry | null> {
    const raw = await this.#client.get(this.#prefix + key);
    if (raw === null) return null;
    let wire: Wire;
    try {
      wire = JSON.parse(raw) as Wire;
    } catch {
      return null;
    }
    return {
      status: wire.s,
      contentType: wire.c,
      body: Buffer.from(wire.b, "base64"),
      storedAt: wire.t,
      expiresAt: wire.e,
      ...(wire.h !== undefined ? { headers: wire.h } : {}),
      ...(wire.v !== undefined ? { vary: wire.v } : {}),
    };
  }

  async set(key: string, entry: CacheEntry, ttlMs: number): Promise<void> {
    const wire: Wire = {
      s: entry.status,
      c: entry.contentType,
      b: Buffer.from(entry.body).toString("base64"),
      t: entry.storedAt,
      e: entry.expiresAt,
    };
    if (entry.headers !== undefined && entry.headers.length > 0) wire.h = entry.headers;
    if (entry.vary !== undefined) wire.v = entry.vary;
    await this.#client.set(this.#prefix + key, JSON.stringify(wire), "PX", ttlMs);
  }
}
