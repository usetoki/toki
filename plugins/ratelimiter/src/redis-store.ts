import type { Store, StoreHit } from "./store.js";

/**
 * Minimal ioredis-compatible surface — the Redis `EVAL` command (server-side Lua, NOT
 * JavaScript eval). Redis, KeyDB, Valkey, Dragonfly, and ioredis/Upstash all match this
 * shape. For node-redis (v4) wrap it in this shape; see the README.
 */
export interface RedisClient {
  // runs a Lua script on the server; the script is a fixed constant here and the key +
  // window are passed as parameterized KEYS/ARGV, so nothing is interpolated/injectable
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisStoreOptions {
  client: RedisClient;
  /** Key prefix in the keyspace. Default `"trl:"`. */
  prefix?: string;
}

// atomic fixed window in one round trip: INCR, set the TTL on the first hit of the
// window, return [count, remaining-ttl-ms]. Eval keeps it race-free under concurrency.
const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}
`;

const DEL_SCRIPT = "return redis.call('DEL', KEYS[1])";

/**
 * {@link Store} backed by Redis — or any Redis-protocol server: KeyDB, Valkey,
 * Dragonfly, Upstash. Counters are shared across every instance pointed at the same
 * server, so this limits a cluster, not just one process.
 */
export class RedisStore implements Store {
  readonly #client: RedisClient;
  readonly #prefix: string;

  constructor(options: RedisStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "trl:";
  }

  async hit(key: string, windowMs: number): Promise<StoreHit> {
    const reply = (await this.#client.eval(HIT_SCRIPT, 1, this.#prefix + key, windowMs)) as [
      number,
      number,
    ];
    const count = Number(reply[0]);
    const ttl = Number(reply[1]);
    return { count, resetAt: Date.now() + (ttl >= 0 ? ttl : windowMs) };
  }

  async reset(key: string): Promise<void> {
    await this.#client.eval(DEL_SCRIPT, 1, this.#prefix + key);
  }
}
