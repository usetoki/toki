import { createHash } from "node:crypto";
import type { BeginResult, IdempotencyRecord, IdempotencyStore } from "./store.ts";

// an Idempotency-Key is client-controlled and may hold spaces/unicode/be huge; memcached
// keys forbid that and cap at 250 bytes, so hash into a fixed, always-valid token.
function memcachedKey(prefix: string, key: string): string {
  return prefix + createHash("sha1").update(key).digest("base64url");
}

/** Minimal memcached surface. memjs matches with a thin wrapper; see the README. */
export interface MemcachedClient {
  get(key: string): Promise<string | null>;
  /** Store only if the key is absent; resolves `true` on success, `false` if it exists. */
  add(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MemcachedStoreOptions {
  client: MemcachedClient;
  /** Key prefix in the keyspace. Default `"idem:"`. */
  prefix?: string;
}

// memcached reads any TTL above 30 days as an absolute unix timestamp; cap below it.
const MAX_TTL_SECONDS = 2_592_000;
const seconds = (ms: number): number =>
  Math.min(MAX_TTL_SECONDS, Math.max(1, Math.ceil(ms / 1000)));

interface Wire {
  f: string;
  r?: { s: number; c: string; b: string; h?: ReadonlyArray<readonly [string, string]> };
}

/**
 * {@link IdempotencyStore} backed by memcached. `add` is atomic, so it wins the
 * reservation race exactly like Redis `SET NX`; a loser reads the slot to decide.
 */
export class MemcachedStore implements IdempotencyStore {
  readonly #client: MemcachedClient;
  readonly #prefix: string;

  constructor(options: MemcachedStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "idem:";
  }

  async begin(key: string, fingerprint: string, lockTtlMs: number): Promise<BeginResult> {
    const k = memcachedKey(this.#prefix, key);
    if (await this.#client.add(k, JSON.stringify({ f: fingerprint }), seconds(lockTtlMs))) {
      return { state: "new" };
    }
    const raw = await this.#client.get(k);
    if (raw === null) return { state: "new" }; // expired between add and get
    let wire: Wire;
    try {
      wire = JSON.parse(raw) as Wire;
    } catch {
      return { state: "in-flight" };
    }
    if (wire.f !== fingerprint) return { state: "mismatch" };
    if (wire.r === undefined) return { state: "in-flight" };
    return {
      state: "replay",
      record: {
        fingerprint: wire.f,
        status: wire.r.s,
        contentType: wire.r.c,
        body: Buffer.from(wire.r.b, "base64"),
        ...(wire.r.h !== undefined ? { headers: wire.r.h } : {}),
      },
    };
  }

  async complete(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> {
    const wire: Wire = {
      f: record.fingerprint,
      r: {
        s: record.status,
        c: record.contentType,
        b: Buffer.from(record.body).toString("base64"),
        ...(record.headers !== undefined ? { h: record.headers } : {}),
      },
    };
    await this.#client.set(memcachedKey(this.#prefix, key), JSON.stringify(wire), seconds(ttlMs));
  }

  async release(key: string): Promise<void> {
    await this.#client.delete(memcachedKey(this.#prefix, key));
  }
}
