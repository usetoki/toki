import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { secureSession } from "../dist/index.js";

const app = createApp({ logger: false });
secureSession(app, { secret: "0123456789abcdef-rolling-secret", maxAge: 1, rolling: true });

app.get("/login", (req) => {
  req.session.set("user", "x");
  return reply.text("ok");
});
app.get("/me", (req) => reply.json({ user: req.session.get("user") ?? null }));

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

type Res = Awaited<ReturnType<typeof app.inject>>;
const cookie = (res: Res): string => {
  const sc = res.headers["set-cookie"];
  const list = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
  return list.find((c) => c.startsWith("session="))?.split(";")[0] ?? "";
};
const user = (res: Res): unknown => (res.json() as { user: unknown }).user;

test("rolling re-issues the cookie even when the session is unchanged", async () => {
  const c1 = cookie(await app.inject({ url: "/login" }));
  assert.ok(c1);
  const me = await app.inject({ url: "/me", headers: { cookie: c1 } });
  assert.ok(cookie(me), "a fresh cookie is sent");
  assert.equal(user(me), "x");
});

test("a session past maxAge is rejected", async () => {
  const c1 = cookie(await app.inject({ url: "/login" }));
  await new Promise((r) => setTimeout(r, 1100)); // maxAge is 1s
  assert.equal(user(await app.inject({ url: "/me", headers: { cookie: c1 } })), null);
});
