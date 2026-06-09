import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import {
  idempotency,
  MemcachedStore,
  MemoryStore,
  RedisStore,
  type MemcachedClient,
  type RedisClient,
} from "../src/index.ts";

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
  async set(
    key: string,
    value: string,
    _mode: "PX",
    ttlMs: number,
    nx?: "NX",
  ): Promise<string | null> {
    const e = this.#m.get(key);
    if (nx === "NX" && e && Date.now() < e.expiresAt) return null;
    this.#m.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }
  async del(key: string): Promise<unknown> {
    this.#m.delete(key);
    return 1;
  }
}

class FakeMemcached implements MemcachedClient {
  readonly #m = new Map<string, { value: string; expiresAt: number }>();
  #live(key: string): string | null {
    const e = this.#m.get(key);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      this.#m.delete(key);
      return null;
    }
    return e.value;
  }
  async get(key: string): Promise<string | null> {
    return this.#live(key);
  }
  async add(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.#live(key) !== null) return false;
    this.#m.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#m.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  async delete(key: string): Promise<void> {
    this.#m.delete(key);
  }
}

const counters = { charge: 0, slow: 0, safe: 0, fail: 0, req: 0, redis: 0, mc: 0 };
const stores: MemoryStore[] = [];
const owned = (): MemoryStore => {
  const s = new MemoryStore();
  stores.push(s);
  return s;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const app = createApp({ logger: false });
app.register(
  (s) => {
    idempotency(s, { store: owned() });
    s.post("/charge", () => reply.json({ id: ++counters.charge }));
    s.post("/slow", async () => {
      await sleep(40);
      return reply.json({ n: ++counters.slow });
    });
    s.post("/fail", () => reply.text(`err ${++counters.fail}`, 500));
    s.post("/staged", (req) => {
      req.setResponseHeader("X-Custom", "abc");
      return reply.json({ id: ++counters.charge });
    });
    s.post("/transfer", (req) => reply.json({ to: req.query.get("to") }));
    s.get("/safe", () => reply.json({ n: ++counters.safe }));
  },
  { prefix: "/a" },
);

app.register(
  (s) => {
    idempotency(s, { store: owned(), required: true });
    s.post("/x", () => reply.json({ ok: ++counters.req }));
  },
  { prefix: "/req" },
);

app.register(
  (s) => {
    idempotency(s, { store: new RedisStore({ client: new FakeRedis() }) });
    s.post("/r", () => reply.json({ n: ++counters.redis }));
  },
  { prefix: "/redis" },
);

app.register(
  (s) => {
    idempotency(s, { store: new MemcachedStore({ client: new FakeMemcached() }) });
    s.post("/m", () => reply.json({ n: ++counters.mc }));
  },
  { prefix: "/mc" },
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => {
  handle.close();
  for (const s of stores) s.close();
});

const key = (k: string) => ({ "idempotency-key": k });
type Res = Awaited<ReturnType<typeof app.inject>>;
const replayed = (res: Res): boolean => res.headers["idempotent-replayed"] === "true";

test("the first request runs and a retry replays the stored response", async () => {
  const first = await app.inject({
    method: "POST",
    url: "/a/charge",
    headers: key("k1"),
    payload: { amt: 10 },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(replayed(first), false);

  const retry = await app.inject({
    method: "POST",
    url: "/a/charge",
    headers: key("k1"),
    payload: { amt: 10 },
  });
  assert.equal(retry.statusCode, 200);
  assert.ok(replayed(retry));
  assert.deepEqual(retry.json(), first.json()); // identical body, handler not re-run
});

test("the same key with different parameters is rejected", async () => {
  await app.inject({ method: "POST", url: "/a/charge", headers: key("k2"), payload: { amt: 1 } });
  const clash = await app.inject({
    method: "POST",
    url: "/a/charge",
    headers: key("k2"),
    payload: { amt: 999 },
  });
  assert.equal(clash.statusCode, 422);
});

test("without a key, requests are not deduplicated", async () => {
  const a = await app.inject({ method: "POST", url: "/a/charge", payload: { amt: 5 } });
  const b = await app.inject({ method: "POST", url: "/a/charge", payload: { amt: 5 } });
  assert.notDeepEqual(a.json(), b.json());
});

test("safe methods are ignored", async () => {
  const a = await app.inject({ method: "GET", url: "/a/safe", headers: key("same") });
  const b = await app.inject({ method: "GET", url: "/a/safe", headers: key("same") });
  assert.notDeepEqual(a.json(), b.json());
});

test("a concurrent retry while one is in flight gets 409", async () => {
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/a/slow", headers: key("k3"), payload: { x: 1 } }),
    app.inject({ method: "POST", url: "/a/slow", headers: key("k3"), payload: { x: 1 } }),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409]);
});

test("a 5xx is not stored and stays retryable", async () => {
  const first = await app.inject({
    method: "POST",
    url: "/a/fail",
    headers: key("k4"),
    payload: {},
  });
  assert.equal(first.statusCode, 500);
  const retry = await app.inject({
    method: "POST",
    url: "/a/fail",
    headers: key("k4"),
    payload: {},
  });
  assert.equal(retry.statusCode, 500);
  assert.notEqual(first.body, retry.body); // re-executed, not replayed or blocked
});

test("required: the header is mandatory", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/req/x", payload: {} })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: "POST", url: "/req/x", headers: key("rq"), payload: {} }))
      .statusCode,
    200,
  );
});

test("a handler-staged header is captured and replayed on an idempotent retry", async () => {
  const first = await app.inject({
    method: "POST",
    url: "/a/staged",
    headers: key("staged-k"),
    payload: { amt: 1 },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(replayed(first), false);
  assert.equal(first.headers["x-custom"], "abc");

  const retry = await app.inject({
    method: "POST",
    url: "/a/staged",
    headers: key("staged-k"),
    payload: { amt: 1 },
  });
  assert.ok(replayed(retry)); // Idempotent-Replayed: true
  assert.equal(retry.headers["x-custom"], "abc"); // staged header survives the replay
  assert.deepEqual(retry.json(), first.json());
});

test("a Redis-backed store dedups and replays", async () => {
  const first = await app.inject({
    method: "POST",
    url: "/redis/r",
    headers: key("rk"),
    payload: { a: 1 },
  });
  const retry = await app.inject({
    method: "POST",
    url: "/redis/r",
    headers: key("rk"),
    payload: { a: 1 },
  });
  assert.ok(replayed(retry));
  assert.deepEqual(retry.json(), first.json());
});

test("the query string is part of the fingerprint — same key + body, different ?to= clashes", async () => {
  const alice = await app.inject({
    method: "POST",
    url: "/a/transfer?to=alice",
    headers: key("xfer"),
    payload: { amt: 100 },
  });
  assert.equal(alice.statusCode, 200);
  assert.deepEqual(alice.json(), { to: "alice" });

  // SAME key, SAME body, but ?to=eve — must NOT replay the alice response; it's a clash
  const eve = await app.inject({
    method: "POST",
    url: "/a/transfer?to=eve",
    headers: key("xfer"),
    payload: { amt: 100 },
  });
  assert.equal(eve.statusCode, 422);
  assert.equal(replayed(eve), false);
});

test("MemoryStore caps stored keys at maxKeys (a unique-key flood can't grow unbounded)", () => {
  const s = new MemoryStore({ maxKeys: 100 });
  for (let i = 0; i < 1000; i++) {
    s.begin(`flood-${i}`, "fp", 60_000);
    assert.ok(s.size <= 100, `size ${s.size} exceeded the cap at i=${i}`);
  }
  assert.ok(s.size <= 100);
  s.close();
});

test("a memcached-backed store dedups and replays", async () => {
  const first = await app.inject({
    method: "POST",
    url: "/mc/m",
    headers: key("mk"),
    payload: { a: 1 },
  });
  const retry = await app.inject({
    method: "POST",
    url: "/mc/m",
    headers: key("mk"),
    payload: { a: 1 },
  });
  assert.ok(replayed(retry));
  assert.deepEqual(retry.json(), first.json());
  const clash = await app.inject({
    method: "POST",
    url: "/mc/m",
    headers: key("mk"),
    payload: { a: 2 },
  });
  assert.equal(clash.statusCode, 422);
});
