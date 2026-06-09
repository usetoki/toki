import type { SessionData, SessionStore } from "./store.ts";

/** Minimal ioredis-compatible surface (also KeyDB / Valkey / Upstash). node-redis v4
 *  uses different signatures — wrap it; see the README. */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  pexpire(key: string, ttlMs: number): Promise<unknown>;
}

export interface RedisStoreOptions {
  client: RedisClient;
  /** key prefix in the keyspace. Default `"sess:"`. */
  prefix?: string;
}

/** {@link SessionStore} backed by Redis — sessions are shared across every instance. */
export class RedisStore implements SessionStore {
  readonly #client: RedisClient;
  readonly #prefix: string;

  constructor(options: RedisStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "sess:";
  }

  async get(sid: string): Promise<SessionData | null> {
    const raw = await this.#client.get(this.#prefix + sid);
    return raw === null ? null : parse(raw);
  }

  async set(sid: string, data: SessionData, ttlMs: number): Promise<void> {
    await this.#client.set(this.#prefix + sid, JSON.stringify(data), "PX", ttlMs);
  }

  async destroy(sid: string): Promise<void> {
    await this.#client.del(this.#prefix + sid);
  }

  async touch(sid: string, ttlMs: number): Promise<void> {
    await this.#client.pexpire(this.#prefix + sid, ttlMs);
  }
}

function parse(raw: string): SessionData | null {
  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}
