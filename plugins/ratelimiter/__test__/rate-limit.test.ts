import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { MemoryStore, rateLimit } from "../dist/index.js";

const app = createApp({ logger: false });
const stores: MemoryStore[] = [];

// a limiter with its own store we can close after the run
function limiter(options: Omit<Parameters<typeof rateLimit>[0], "store">) {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({ ...options, store });
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
