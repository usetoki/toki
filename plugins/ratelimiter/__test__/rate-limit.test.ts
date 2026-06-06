import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import {
  MemcachedStore,
  MemoryStore,
  RedisStore,
  rateLimit,
  type MemcachedClient,
  type RateLimitOptions,
  type RedisClient,
  type Store,
  type StoreHit,
} from "../dist/index.js";

const app = createApp({ logger: false });
const stores: MemoryStore[] = [];

// a limiter with its own MemoryStore we can close after the run
function limiter(options: Omit<Parameters<typeof rateLimit>[0], "store">) {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({ ...options, store });
}

// in-memory stand-ins for the real servers, exercising the store contract end to end
class FakeRedis implements RedisClient {
  readonly #m = new Map<string, { count: number; resetAt: number }>();
  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = String(args[0]);
    if (script.includes("DEL")) {
      this.#m.delete(key);
      return 1;
    }
    const windowMs = Number(args[1]);
    const now = Date.now();
    let bucket = this.#m.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      bucket = { count: 1, resetAt: now + windowMs };
      this.#m.set(key, bucket);
    } else {
      bucket.count += 1;
    }
    return [bucket.count, bucket.resetAt - now];
  }
}

// a store that always fails, standing in for an unreachable Redis/memcached
class DownStore implements Store {
  async hit(): Promise<StoreHit> {
    throw new Error("store down");
  }
}

class FakeMemcached implements MemcachedClient {
  readonly #m = new Map<string, number>();
  async add(key: string, value: string, _ttlSeconds: number): Promise<boolean> {
    if (this.#m.has(key)) return false;
    this.#m.set(key, Number(value));
    return true;
  }
  async incr(key: string, amount: number): Promise<number | null> {
    const value = this.#m.get(key);
    if (value === undefined) return null;
    const next = value + amount;
    this.#m.set(key, next);
    return next;
  }
}

app.register(
  (s) => {
    s.get("/a", { preHandler: limiter({ max: 2, windowMs: 60_000 }) }, () => reply.text("ok"));
    s.get("/b", { preHandler: limiter({ max: 1, windowMs: 60_000, message: "slow down" }) }, () =>
      reply.text("ok"),
    );
    s.get(
      "/c",
      {
        preHandler: limiter({
          max: 1,
          windowMs: 60_000,
          standardHeaders: false,
          legacyHeaders: true,
        }),
      },
      () => reply.text("ok"),
    );
    s.get(
      "/d",
      {
        preHandler: limiter({
          max: 1,
          windowMs: 60_000,
          keyGenerator: (req) => req.query.get("u") ?? req.ip,
        }),
      },
      () => reply.text("ok"),
    );
    s.get(
      "/redis",
      {
        preHandler: rateLimit({
          max: 2,
          windowMs: 60_000,
          store: new RedisStore({ client: new FakeRedis() }),
        }),
      },
      () => reply.text("ok"),
    );
    s.get(
      "/memcached",
      {
        preHandler: rateLimit({
          max: 2,
          windowMs: 60_000,
          store: new MemcachedStore({ client: new FakeMemcached() }),
        }),
      },
      () => reply.text("ok"),
    );
    s.get(
      "/down-open",
      { preHandler: rateLimit({ max: 1, windowMs: 60_000, store: new DownStore() }) },
      () => reply.text("ok"),
    );
    s.get(
      "/down-closed",
      {
        preHandler: rateLimit({
          max: 1,
          windowMs: 60_000,
          store: new DownStore(),
          onStoreError: "closed",
        }),
      },
      () => reply.text("ok"),
    );
    s.get(
      "/msgfn",
      {
        // a builder that (wrongly) returns nothing — must not pass a blocked request through
        preHandler: limiter({
          max: 1,
          windowMs: 60_000,
          message: (() => undefined) as unknown as NonNullable<RateLimitOptions["message"]>,
        }),
      },
      () => reply.text("ok"),
    );
  },
  { prefix: "/r" },
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => {
  handle.close();
  for (const store of stores) store.close();
});

test("requests under the limit pass and carry RateLimit headers", async () => {
  const r = await app.inject({ url: "/r/a" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["ratelimit-limit"], "2");
  assert.equal(r.headers["ratelimit-remaining"], "1");
});

test("over the limit gets 429 with Retry-After", async () => {
  // route /a allows 2; one was spent above, this spends the 2nd then trips on the 3rd
  const second = await app.inject({ url: "/r/a" });
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["ratelimit-remaining"], "0");

  const third = await app.inject({ url: "/r/a" });
  assert.equal(third.statusCode, 429);
  assert.ok(Number(third.headers["retry-after"]) >= 0);
  assert.match(String(third.body), /Too Many Requests/);
});

test("a string message becomes the 429 body message", async () => {
  await app.inject({ url: "/r/b" });
  const blocked = await app.inject({ url: "/r/b" });
  assert.equal(blocked.statusCode, 429);
  assert.match(String(blocked.body), /slow down/);
});

test("legacyHeaders swaps RateLimit-* for X-RateLimit-*", async () => {
  const r = await app.inject({ url: "/r/c" });
  assert.equal(r.headers["x-ratelimit-limit"], "1");
  assert.equal(r.headers["ratelimit-limit"], undefined);
});

test("a custom keyGenerator gives each key its own budget", async () => {
  const alice = await app.inject({ url: "/r/d?u=alice" });
  assert.equal(alice.statusCode, 200);
  const bob = await app.inject({ url: "/r/d?u=bob" });
  assert.equal(bob.statusCode, 200); // different key, fresh budget
  const aliceAgain = await app.inject({ url: "/r/d?u=alice" });
  assert.equal(aliceAgain.statusCode, 429); // alice's single request is spent
});

test("RedisStore (Redis/KeyDB) drives the limiter", async () => {
  assert.equal((await app.inject({ url: "/r/redis" })).statusCode, 200);
  const second = await app.inject({ url: "/r/redis" });
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["ratelimit-remaining"], "0");
  const blocked = await app.inject({ url: "/r/redis" });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers["ratelimit-limit"], "2");
  assert.ok(Number(blocked.headers["retry-after"]) >= 0);
});

test("MemcachedStore drives the limiter", async () => {
  assert.equal((await app.inject({ url: "/r/memcached" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/r/memcached" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/r/memcached" })).statusCode, 429);
});

test("a store outage fails open by default — the request passes", async () => {
  assert.equal((await app.inject({ url: "/r/down-open" })).statusCode, 200);
});

test("onStoreError 'closed' blocks the request when the store is down", async () => {
  const r = await app.inject({ url: "/r/down-closed" });
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers["retry-after"]) >= 0);
});

test("a message builder returning nothing falls back to the default 429 body", async () => {
  assert.equal((await app.inject({ url: "/r/msgfn" })).statusCode, 200);
  const blocked = await app.inject({ url: "/r/msgfn" });
  assert.equal(blocked.statusCode, 429);
  assert.match(String(blocked.body), /rate limit exceeded/);
});

test("MemcachedStore caps the TTL below the 30-day epoch threshold", async () => {
  let seenTtl = -1;
  const client: MemcachedClient = {
    async add(_k: string, _v: string, ttl: number): Promise<boolean> {
      seenTtl = ttl;
      return true;
    },
    async incr(): Promise<number | null> {
      return null;
    },
  };
  await new MemcachedStore({ client }).hit("k", 40 * 24 * 3600 * 1000); // 40-day window
  assert.ok(seenTtl > 0 && seenTtl <= 2_592_000, `ttl ${seenTtl} must stay a relative offset`);
});
