import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import {
  cache,
  MemcachedStore,
  MemoryStore,
  RedisStore,
  type MemcachedClient,
  type RedisClient,
} from "../dist/index.js";

// in-memory stand-in for Redis, honoring the PX TTL
class FakeRedis implements RedisClient {
  readonly #m = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.#m.get(key);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      this.#m.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, _mode: "PX", ttlMs: number): Promise<unknown> {
    this.#m.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }
}

class FakeMemcached implements MemcachedClient {
  readonly #m = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.#m.get(key);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      this.#m.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#m.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  async delete(key: string): Promise<void> {
    this.#m.delete(key);
  }
}

const counters = { c: 0, vary: 0, ttl: 0, redis: 0, notFound: 0, priv: 0, mc: 0 };
const stores: MemoryStore[] = [];
const owned = (): MemoryStore => {
  const s = new MemoryStore();
  stores.push(s);
  return s;
};

const app = createApp({ logger: false });

app.register(
  (s) => {
    cache(s, { ttl: 60, store: owned() });
    s.get("/data", () => reply.json({ n: ++counters.c }));
    s.get("/bytes", () => reply.bytes(new Uint8Array([1, 2, 3]), "application/octet-stream"));
    s.post("/data", () => reply.text("posted"));
    s.get("/missing", () => reply.text(`gone ${++counters.notFound}`, 404));
    s.get("/private", (req) => {
      req.setResponseHeader("Cache-Control", "private");
      return reply.json({ n: ++counters.priv });
    });
    s.get("/staged", (req) => {
      req.setResponseHeader("X-Custom", "abc");
      return reply.json({ n: ++counters.c });
    });
  },
  { prefix: "/c" },
);

app.register(
  (s) => {
    cache(s, { ttl: 60, store: owned(), vary: ["accept-language"] });
    s.get("/data", () => reply.json({ n: ++counters.vary }));
  },
  { prefix: "/v" },
);

app.register(
  (s) => {
    cache(s, { ttl: 1, store: owned() });
    s.get("/data", () => reply.json({ n: ++counters.ttl }));
  },
  { prefix: "/t" },
);

app.register(
  (s) => {
    cache(s, { ttl: 60, store: new RedisStore({ client: new FakeRedis() }) });
    s.get("/data", () => reply.json({ n: ++counters.redis }));
  },
  { prefix: "/r" },
);

app.register(
  (s) => {
    cache(s, { ttl: 60, store: owned(), statuses: [301] });
    s.get("/go", () => reply.redirect("/dest", 301));
  },
  { prefix: "/h" },
);

app.register(
  (s) => {
    cache(s, { ttl: 60, store: new MemcachedStore({ client: new FakeMemcached() }) });
    s.get("/data", () => reply.json({ n: ++counters.mc }));
  },
  { prefix: "/m" },
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => {
  handle.close();
  for (const s of stores) s.close();
});

type Res = Awaited<ReturnType<typeof app.inject>>;
const xcache = (res: Res): string | undefined => res.headers["x-cache"] as string | undefined;

test("a second request is served from cache (handler runs once)", async () => {
  const first = await app.inject({ url: "/c/data" });
  assert.equal(xcache(first), "MISS");
  assert.deepEqual(first.json(), { n: 1 });

  const second = await app.inject({ url: "/c/data" });
  assert.equal(xcache(second), "HIT");
  assert.deepEqual(second.json(), { n: 1 }); // same body, handler not re-run
  assert.ok(Number(second.headers["age"]) >= 0);
});

test("the query string partitions the cache", async () => {
  const a = await app.inject({ url: "/c/data?p=1" });
  const b = await app.inject({ url: "/c/data?p=2" });
  assert.notDeepEqual(a.json(), b.json()); // different keys → handler ran for each
  const aAgain = await app.inject({ url: "/c/data?p=1" });
  assert.deepEqual(aAgain.json(), a.json());
});

test("a binary body round-trips intact", async () => {
  await app.inject({ url: "/c/bytes" }); // warm the cache
  const second = await app.inject({ url: "/c/bytes" });
  assert.equal(xcache(second), "HIT");
  assert.deepEqual([...second.rawPayload], [1, 2, 3]);
  assert.equal(second.headers["content-type"], "application/octet-stream");
});

test("non-GET methods are not cached", async () => {
  assert.equal(xcache(await app.inject({ method: "POST", url: "/c/data" })), undefined);
});

test("non-200 responses are not cached", async () => {
  const before = counters.notFound;
  await app.inject({ url: "/c/missing" });
  await app.inject({ url: "/c/missing" });
  assert.equal(counters.notFound, before + 2); // handler ran both times
});

test("Cache-Control: no-store bypasses the cache both ways", async () => {
  const headers = { "cache-control": "no-store" };
  const a = await app.inject({ url: "/c/data?fresh=1", headers });
  const b = await app.inject({ url: "/c/data?fresh=1", headers });
  assert.equal(xcache(a), undefined);
  assert.notDeepEqual(a.json(), b.json());
});

test("Vary partitions the cache by header and echoes Vary", async () => {
  const en = await app.inject({ url: "/v/data", headers: { "accept-language": "en" } });
  assert.equal(en.headers["vary"], "accept-language");
  const enAgain = await app.inject({ url: "/v/data", headers: { "accept-language": "en" } });
  assert.deepEqual(enAgain.json(), en.json());
  const fr = await app.inject({ url: "/v/data", headers: { "accept-language": "fr" } });
  assert.notDeepEqual(fr.json(), en.json());
});

test("an entry past its TTL is refetched", async () => {
  const first = await app.inject({ url: "/t/data" });
  await new Promise((r) => setTimeout(r, 1100)); // ttl is 1s
  const second = await app.inject({ url: "/t/data" });
  assert.equal(xcache(second), "MISS");
  assert.notDeepEqual(second.json(), first.json());
});

test("a Redis-backed store drives the cache", async () => {
  const first = await app.inject({ url: "/r/data" });
  assert.equal(xcache(first), "MISS");
  const second = await app.inject({ url: "/r/data" });
  assert.equal(xcache(second), "HIT");
  assert.deepEqual(second.json(), first.json());
});

test("a memcached-backed store drives the cache", async () => {
  const first = await app.inject({ url: "/m/data" });
  assert.equal(xcache(first), "MISS");
  const second = await app.inject({ url: "/m/data" });
  assert.equal(xcache(second), "HIT");
  assert.deepEqual(second.json(), first.json());
});

test("a response marked Cache-Control: private is never cached", async () => {
  const before = counters.priv;
  const a = await app.inject({ url: "/c/private" });
  await app.inject({ url: "/c/private" });
  assert.equal(xcache(a), undefined); // not stored
  assert.equal(counters.priv, before + 2); // handler ran both times
});

test("cached extra headers (e.g. a redirect Location) are replayed on a hit", async () => {
  const first = await app.inject({ url: "/h/go" });
  assert.equal(first.statusCode, 301);
  assert.equal(first.headers["location"], "/dest");
  const second = await app.inject({ url: "/h/go" });
  assert.equal(xcache(second), "HIT");
  assert.equal(second.statusCode, 301);
  assert.equal(second.headers["location"], "/dest");
});

test("handler-staged headers (req.setResponseHeader) are stored and replayed on a hit", async () => {
  const first = await app.inject({ url: "/c/staged" });
  assert.equal(xcache(first), "MISS");
  assert.equal(first.headers["x-custom"], "abc");

  const second = await app.inject({ url: "/c/staged" });
  assert.equal(xcache(second), "HIT");
  assert.equal(second.headers["x-custom"], "abc"); // staged header survives the replay
});

test("MemoryStore eviction is LRU — a read protects an entry", () => {
  const store = new MemoryStore({ max: 2 });
  const mk = () => ({
    status: 200,
    contentType: "text/plain",
    body: new Uint8Array([0]),
    storedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  store.set("a", mk());
  store.set("b", mk());
  store.get("a"); // touch "a" so "b" is now the least-recently-used
  store.set("c", mk()); // evicts "b", not "a"
  assert.ok(store.get("a"));
  assert.equal(store.get("b"), null);
  assert.ok(store.get("c"));
  store.close();
});

test("MemoryStore evicts the oldest entry past its max", () => {
  const store = new MemoryStore({ max: 2 });
  const mk = (n: number) => ({
    status: 200,
    contentType: "text/plain",
    body: new Uint8Array([n]),
    storedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  store.set("a", mk(1));
  store.set("b", mk(2));
  store.set("c", mk(3)); // evicts "a"
  assert.equal(store.get("a"), null);
  assert.ok(store.get("b"));
  assert.ok(store.get("c"));
  store.close();
});
