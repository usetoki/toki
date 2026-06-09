import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { secureSession } from "../src/index.ts";

const app = createApp({ logger: false });
secureSession(app, { secret: "0123456789abcdef-test-session-secret" });

app.get("/me", (req) => reply.json({ user: req.session.get("user") ?? null }));
app.get("/login", (req) => {
  req.session.set("user", "alice");
  return reply.text("ok");
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
app.get("/big", (req) => {
  req.session.set("blob", "x".repeat(5000)); // over the ~4KB cookie limit
  return reply.text("ok");
});

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

type Res = Awaited<ReturnType<typeof app.inject>>;

function sessionCookie(res: Res): string {
  const sc = res.headers["set-cookie"];
  const list = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
  return list.find((c) => c.startsWith("session="))?.split(";")[0] ?? "";
}

test("an unmodified session sets no cookie", async () => {
  const r = await app.inject({ url: "/me" });
  assert.deepEqual(r.json(), { user: null });
  assert.equal(r.headers["set-cookie"], undefined);
});

test("a session round-trips through the cookie", async () => {
  const login = await app.inject({ url: "/login" });
  const cookie = sessionCookie(login);
  assert.ok(cookie, "login issues a session cookie");
  const me = await app.inject({ url: "/me", headers: { cookie } });
  assert.deepEqual(me.json(), { user: "alice" });
});

test("reading an unchanged session does not re-issue the cookie", async () => {
  const cookie = sessionCookie(await app.inject({ url: "/login" }));
  const me = await app.inject({ url: "/me", headers: { cookie } });
  assert.equal(me.headers["set-cookie"], undefined);
});

test("a tampered cookie falls back to a fresh empty session", async () => {
  const cookie = sessionCookie(await app.inject({ url: "/login" }));
  const tampered = cookie.slice(0, -2) + "xx";
  const me = await app.inject({ url: "/me", headers: { cookie: tampered } });
  assert.deepEqual(me.json(), { user: null });
});

test("destroy expires the cookie", async () => {
  const cookie = sessionCookie(await app.inject({ url: "/login" }));
  const out = await app.inject({ url: "/logout", headers: { cookie } });
  const sc = out.headers["set-cookie"];
  assert.ok(sc, "logout sends a Set-Cookie");
  const list = Array.isArray(sc) ? sc : [sc];
  assert.ok(list.some((c) => /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c)));
});

test("session state accumulates across requests", async () => {
  const a = await app.inject({ url: "/count" });
  assert.deepEqual(a.json(), { n: 1 });
  const b = await app.inject({ url: "/count", headers: { cookie: sessionCookie(a) } });
  assert.deepEqual(b.json(), { n: 2 });
  const c = await app.inject({ url: "/count", headers: { cookie: sessionCookie(b) } });
  assert.deepEqual(c.json(), { n: 3 });
});

test("a session larger than the cookie limit is rejected", async () => {
  const r = await app.inject({ url: "/big" });
  assert.equal(r.statusCode, 500);
});
