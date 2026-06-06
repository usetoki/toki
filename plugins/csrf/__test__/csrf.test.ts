import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { csrf } from "../dist/index.js";

const SECRET = "0123456789abcdef-csrf-secret";
const app = createApp({ logger: false });

function routes(s: Parameters<Parameters<typeof app.register>[0]>[0]) {
  s.get("/token", (req) => reply.json({ token: req.csrfToken() }));
  s.post("/submit", () => reply.text("ok"));
}
app.register(
  (s) => {
    csrf(s, { secret: SECRET });
    routes(s);
    s.get("/double", (req) => reply.json({ a: req.csrfToken(), b: req.csrfToken() }));
  },
  { prefix: "/a" },
);
app.register(
  (s) => {
    csrf(s, { secret: SECRET, checkOrigin: true });
    routes(s);
  },
  { prefix: "/b" },
);
app.register(
  (s) => {
    csrf(s, { secret: SECRET, checkOrigin: ["trusted.host"] });
    routes(s);
  },
  { prefix: "/c" },
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

type Res = Awaited<ReturnType<typeof app.inject>>;
const cookieOf = (res: Res): string => {
  const sc = res.headers["set-cookie"];
  const list = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
  return list.find((c) => c.startsWith("_csrf="))?.split(";")[0] ?? "";
};
async function issue(prefix: string): Promise<{ cookie: string; token: string }> {
  const res = await app.inject({ url: `/${prefix}/token` });
  return { cookie: cookieOf(res), token: (res.json() as { token: string }).token };
}
const status = (res: Res): number => res.statusCode;

test("issuing a token sets a signed cookie and returns the raw value", async () => {
  const { cookie, token } = await issue("a");
  assert.ok(cookie.startsWith("_csrf="));
  assert.ok(token.length > 0);
});

test("a valid token in the header passes", async () => {
  const { cookie, token } = await issue("a");
  const res = await app.inject({
    method: "POST",
    url: "/a/submit",
    headers: { cookie, "x-csrf-token": token },
  });
  assert.equal(status(res), 200);
  assert.equal(res.body, "ok");
});

test("a valid token in a form field passes", async () => {
  const { cookie, token } = await issue("a");
  const res = await app.inject({
    method: "POST",
    url: "/a/submit",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: `_csrf=${token}`,
  });
  assert.equal(status(res), 200);
});

test("a missing token is rejected", async () => {
  const { cookie } = await issue("a");
  assert.equal(
    status(await app.inject({ method: "POST", url: "/a/submit", headers: { cookie } })),
    403,
  );
});

test("a wrong token is rejected", async () => {
  const { cookie } = await issue("a");
  const res = await app.inject({
    method: "POST",
    url: "/a/submit",
    headers: { cookie, "x-csrf-token": "not-the-token" },
  });
  assert.equal(status(res), 403);
});

test("a token without the matching cookie is rejected", async () => {
  const { token } = await issue("a");
  const res = await app.inject({
    method: "POST",
    url: "/a/submit",
    headers: { "x-csrf-token": token },
  });
  assert.equal(status(res), 403);
});

test("a tampered cookie is rejected", async () => {
  const { cookie, token } = await issue("a");
  const res = await app.inject({
    method: "POST",
    url: "/a/submit",
    headers: { cookie: cookie.slice(0, -2) + "xx", "x-csrf-token": token },
  });
  assert.equal(status(res), 403);
});

test("safe methods skip the check", async () => {
  // GET /a/token already succeeds with no token — proves GET is ignored
  assert.equal(status(await app.inject({ url: "/a/token" })), 200);
});

test("csrfToken() is idempotent within a request", async () => {
  const res = await app.inject({ url: "/a/double" });
  const { a, b } = res.json() as { a: string; b: string };
  assert.equal(a, b); // two calls, one token
  const sc = res.headers["set-cookie"];
  const cookies = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
  assert.equal(cookies.filter((c) => c.startsWith("_csrf=")).length, 1); // one cookie, not two
});

test("checkOrigin: a same-origin request passes, a foreign one is rejected", async () => {
  const { cookie, token } = await issue("b");
  const ok = await app.inject({
    method: "POST",
    url: "/b/submit",
    headers: { cookie, "x-csrf-token": token, host: "app.test", origin: "https://app.test" },
  });
  assert.equal(status(ok), 200);

  const foreign = await app.inject({
    method: "POST",
    url: "/b/submit",
    headers: { cookie, "x-csrf-token": token, host: "app.test", origin: "https://evil.test" },
  });
  assert.equal(status(foreign), 403);
});

test("checkOrigin: a request with no Origin/Referer is rejected", async () => {
  const { cookie, token } = await issue("b");
  const res = await app.inject({
    method: "POST",
    url: "/b/submit",
    headers: { cookie, "x-csrf-token": token, host: "app.test" },
  });
  assert.equal(status(res), 403);
});

test("checkOrigin allow-list admits a listed host", async () => {
  const { cookie, token } = await issue("c");
  const ok = await app.inject({
    method: "POST",
    url: "/c/submit",
    headers: { cookie, "x-csrf-token": token, origin: "https://trusted.host" },
  });
  assert.equal(status(ok), 200);

  const other = await app.inject({
    method: "POST",
    url: "/c/submit",
    headers: { cookie, "x-csrf-token": token, origin: "https://other.host" },
  });
  assert.equal(status(other), 403);
});
