import { createHash } from "node:crypto";
import type { CacheEntry, CacheStore } from "./store.js";

/** Minimal memcached surface. memjs matches with a thin wrapper; see the README. */
export interface MemcachedClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// memcached keys forbid spaces/control bytes and cap at 250 bytes — the default cache key
// ("GET /path?q=1") has spaces, so hash it into a fixed, always-valid token.
function memcachedKey(prefix: string, key: string): string {
  return prefix + createHash("sha1").update(key).digest("base64url");
}

export interface MemcachedStoreOptions {
  client: MemcachedClient;
  /** Key prefix in the keyspace. Default `"cache:"`. */
  prefix?: string;
}

// memcached reads any TTL above 30 days as an absolute unix timestamp; cap below it.
const MAX_TTL_SECONDS = 2_592_000;

interface Wire {
  s: number;
  c: string;
  b: string;
  h?: ReadonlyArray<readonly [string, string]>;
  v?: string;
  t: number;
  e: number;
}

/** {@link CacheStore} backed by memcached — cached responses are shared across instances. */
export class MemcachedStore implements CacheStore {
  readonly #client: MemcachedClient;
  readonly #prefix: string;

  constructor(options: MemcachedStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "cache:";
  }

  async get(key: string): Promise<CacheEntry | null> {
    const raw = await this.#client.get(memcachedKey(this.#prefix, key));
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
    const ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.max(1, Math.ceil(ttlMs / 1000)));
    await this.#client.set(memcachedKey(this.#prefix, key), JSON.stringify(wire), ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.#client.delete(memcachedKey(this.#prefix, key));
  }
}
