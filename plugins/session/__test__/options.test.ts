import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { MemoryStore, session } from "../src/index.ts";

const store = new MemoryStore();
const app = createApp({ logger: false });
session(app, { secret: "0123456789abcdef-rolling-store", store, maxAge: 1, rolling: true });

app.get("/login", (req) => {
  req.session.set("user", "x");
  return reply.text("ok");
});
app.get("/me", (req) => reply.json({ user: req.session.get("user") ?? null }));

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => {
  handle.close();
  store.close();
});

type Res = Awaited<ReturnType<typeof app.inject>>;
const cookie = (res: Res): string => {
  const sc = res.headers["set-cookie"];
  const list = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
  return list.find((c) => c.startsWith("sid="))?.split(";")[0] ?? "";
};
const user = (res: Res): unknown => (res.json() as { user: unknown }).user;

test("rolling re-issues the cookie on every response", async () => {
  const c1 = cookie(await app.inject({ url: "/login" }));
  assert.ok(c1);
  const me = await app.inject({ url: "/me", headers: { cookie: c1 } });
  assert.ok(cookie(me), "a fresh cookie is sent even when unchanged");
  assert.equal(user(me), "x");
});

test("a session whose store entry has expired resolves empty", async () => {
  const c1 = cookie(await app.inject({ url: "/login" }));
  await new Promise((r) => setTimeout(r, 1100)); // store TTL is 1s; no touch in between
  assert.equal(user(await app.inject({ url: "/me", headers: { cookie: c1 } })), null);
});
