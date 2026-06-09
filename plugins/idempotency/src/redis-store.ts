import type { BeginResult, IdempotencyRecord, IdempotencyStore } from "./store.js";

/** Minimal ioredis-compatible surface (also KeyDB / Valkey / Upstash). */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  /** `SET key value PX ttl [NX]` — with `nx`, only stores when the key is absent. */
  set(key: string, value: string, mode: "PX", ttlMs: number, nx?: "NX"): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export interface RedisStoreOptions {
  client: RedisClient;
  /** Key prefix in the keyspace. Default `"idem:"`. */
  prefix?: string;
}

interface Wire {
  f: string;
  r?: { s: number; c: string; b: string; h?: ReadonlyArray<readonly [string, string]> };
}

/** {@link IdempotencyStore} backed by Redis, so keys are shared across every instance. */
export class RedisStore implements IdempotencyStore {
  readonly #client: RedisClient;
  readonly #prefix: string;

  constructor(options: RedisStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "idem:";
  }

  async begin(key: string, fingerprint: string, lockTtlMs: number): Promise<BeginResult> {
    const k = this.#prefix + key;
    // reserve atomically: SET NX wins the race to run; a loser inspects the existing slot
    const reserved = await this.#client.set(
      k,
      JSON.stringify({ f: fingerprint }),
      "PX",
      lockTtlMs,
      "NX",
    );
    if (reserved !== null) return { state: "new" };

    const raw = await this.#client.get(k);
    if (raw === null) return { state: "new" }; // expired between the SET and the GET; race to retry
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
    await this.#client.set(this.#prefix + key, JSON.stringify(wire), "PX", ttlMs);
  }

  async release(key: string): Promise<void> {
    await this.#client.del(this.#prefix + key);
  }
}
