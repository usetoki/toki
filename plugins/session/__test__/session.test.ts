import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { MemcachedStore, MemoryStore, RedisStore, session } from "../src/index.ts";

const store = new MemoryStore();
const app = createApp({ logger: false });
session(app, { secret: "0123456789abcdef-stateful-session", store });

app.get("/me", (req) => reply.json({ user: req.session.get("user") ?? null, id: req.session.id }));
app.get("/set", (req) => {
  req.session.set("user", "bob");
  return reply.json({ id: req.session.id });
});
app.get("/login", (req) => {
  req.session.regenerate();
  req.session.set("user", "alice");
  return reply.json({ id: req.session.id });
});
app.get("/logout", (req) => {
  req.session.destroy();
  return reply.text("bye");
});
app.get("/count", (req) => {
  const n = (req.session.get<number>("n") ?? 0) + 1;
  req.session.set("n", n);
  return reply.json({ n });
});

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => {
  handle.close();
  store.close();
});

type Res = Awaited<ReturnType<typeof app.inject>>;
type Body = { user: string | null; id: string; n: number };
const body = (res: Res): Body => res.json() as Body;

function sidCookie(res: Res): string {
  const sc = res.headers["set-cookie"];
  const list = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
  return list.find((c) => c.startsWith("sid="))?.split(";")[0] ?? "";
}

test("an unused session writes nothing", async () => {
  const r = await app.inject({ url: "/me" });
  assert.equal(body(r).user, null);
  assert.equal(r.headers["set-cookie"], undefined);
});

test("session data persists in the store across requests", async () => {
  const set = await app.inject({ url: "/set" });
  const cookie = sidCookie(set);
  assert.ok(cookie);
  const me = await app.inject({ url: "/me", headers: { cookie } });
  assert.equal(body(me).user, "bob");
  assert.equal(body(me).id, body(set).id);
});

test("a tampered id cookie is rejected (signature)", async () => {
  const cookie = sidCookie(await app.inject({ url: "/set" }));
  const me = await app.inject({ url: "/me", headers: { cookie: cookie.slice(0, -2) + "xx" } });
  assert.equal(body(me).user, null);
});

test("regenerate rotates the id and drops the old session", async () => {
  const set = await app.inject({ url: "/set" });
  const c1 = sidCookie(set);
  const login = await app.inject({ url: "/login", headers: { cookie: c1 } });
  const c2 = sidCookie(login);
  assert.notEqual(body(login).id, body(set).id, "id rotated");
  assert.ok(c2 && c2 !== c1, "a new cookie is issued");

  const oldSession = await app.inject({ url: "/me", headers: { cookie: c1 } });
  assert.equal(body(oldSession).user, null, "old id no longer resolves");
  const newSession = await app.inject({ url: "/me", headers: { cookie: c2 } });
  assert.equal(body(newSession).user, "alice");
});

test("destroy removes the session and clears the cookie", async () => {
  const cookie = sidCookie(await app.inject({ url: "/set" }));
  const out = await app.inject({ url: "/logout", headers: { cookie } });
  const sc = out.headers["set-cookie"];
  assert.ok(sc);
  assert.ok((Array.isArray(sc) ? sc : [sc]).some((c) => /Max-Age=0/.test(c)));
  const me = await app.inject({ url: "/me", headers: { cookie } });
  assert.equal(body(me).user, null);
});

test("session state accumulates across requests", async () => {
  const a = await app.inject({ url: "/count" });
  assert.equal(body(a).n, 1);
  const b = await app.inject({ url: "/count", headers: { cookie: sidCookie(a) } });
  assert.equal(body(b).n, 2);
});

// --- store adapters (unit, no app needed) -----------------------------------

test("RedisStore stores JSON with a millisecond TTL and round-trips", async () => {
  const calls: string[] = [];
  const kv = new Map<string, string>();
  const client = {
    async get(key: string): Promise<string | null> {
      return kv.get(key) ?? null;
    },
    async set(key: string, value: string, mode: "PX", ttl: number): Promise<void> {
      calls.push(`set ${key} ${mode} ${ttl}`);
      kv.set(key, value);
    },
    async del(key: string): Promise<void> {
      calls.push(`del ${key}`);
      kv.delete(key);
    },
    async pexpire(): Promise<void> {},
  };
  const s = new RedisStore({ client });
  await s.set("abc", { user: "x" }, 1000);
  assert.deepEqual(await s.get("abc"), { user: "x" });
  await s.destroy("abc");
  assert.equal(await s.get("abc"), null);
  assert.ok(calls.includes("set sess:abc PX 1000"));
  assert.ok(calls.includes("del sess:abc"));
});

test("MemcachedStore stores JSON with a second TTL and round-trips", async () => {
  const kv = new Map<string, string>();
  const client = {
    async get(key: string): Promise<string | null> {
      return kv.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      kv.set(key, value);
    },
    async delete(key: string): Promise<void> {
      kv.delete(key);
    },
  };
  const s = new MemcachedStore({ client });
  await s.set("k", { a: 1 }, 5000);
  assert.deepEqual(await s.get("k"), { a: 1 });
  await s.destroy("k");
  assert.equal(await s.get("k"), null);
});

test("MemoryStore expires entries by TTL", async () => {
  const s = new MemoryStore();
  s.set("k", { a: 1 }, 5); // 5ms
  assert.deepEqual(s.get("k"), { a: 1 });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.get("k"), null);
  s.close();
});

test("MemoryStore touch slides the TTL", async () => {
  const s = new MemoryStore();
  s.set("k", { a: 1 }, 30);
  await new Promise((r) => setTimeout(r, 10));
  s.touch("k", 100);
  await new Promise((r) => setTimeout(r, 40)); // past the original 30ms, within the touched 100ms
  assert.deepEqual(s.get("k"), { a: 1 });
  s.close();
});

test("MemcachedStore caps the TTL below the 30-day epoch threshold", async () => {
  let seenTtl = -1;
  const client = {
    async get(): Promise<string | null> {
      return null;
    },
    async set(_k: string, _v: string, ttl: number): Promise<void> {
      seenTtl = ttl;
    },
    async delete(): Promise<void> {},
  };
  await new MemcachedStore({ client }).set("sid", { a: 1 }, 40 * 24 * 3600 * 1000); // 40 days
  assert.ok(seenTtl > 0 && seenTtl <= 2_592_000, `ttl ${seenTtl} must stay a relative offset`);
});

test("MemoryStore caps stored sessions at maxKeys — an early sid is evicted, recent ones survive", () => {
  const s = new MemoryStore(60_000, 100);
  for (let i = 0; i < 1000; i++) s.set(`sid-${i}`, { i }, 60_000);
  // a client minting a fresh session per request can't grow memory without bound: the
  // oldest-inserted sid was pushed out, while the most-recent ones are still resolvable.
  assert.equal(s.get("sid-0"), null, "an early sid was evicted");
  assert.deepEqual(s.get("sid-999"), { i: 999 }, "a recent sid survives");
  s.close();
});
