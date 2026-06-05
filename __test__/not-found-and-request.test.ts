import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "../dist/index.js";

const seen: string[] = [];

const app = createApp({ logger: false });

app.addHook("onRequest", (req) => {
  seen.push(req.path);
});

app.get("/here", (req) => reply.json({ ip: req.ip, host: req.hostname, proto: req.protocol }));
app.get("/id", (req) => reply.json({ id: req.id }));
app.get("/hdrs", (req) =>
  reply.json({
    isHeaders: req.headers instanceof Headers,
    ua: req.headers.get("user-agent"),
    count: [...req.headers.keys()].length,
  }),
);

app.setErrorHandler((_req, err) => reply.json({ caught: (err as Error).message }, 500));

app.setNotFoundHandler((req) => {
  if (req.path === "/nf/throw") {
    throw new Error("boom-in-nf");
  }
  if (req.path === "/nf/redirect") {
    return reply.redirect("/login", 302);
  }
  return reply.json({ missing: req.path, method: req.method, ip: req.ip }, 404);
});

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("req.ip / hostname / protocol are populated on a loopback request", async () => {
  const body = (await app.inject("/here")).json<{ ip: string; host: string; proto: string }>();
  assert.match(body.ip, /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
  assert.equal(body.host, "127.0.0.1");
  assert.equal(body.proto, "http");
});

test("protocol honors X-Forwarded-Proto", async () => {
  const r = await app.inject({ url: "/here", headers: { "X-Forwarded-Proto": "https" } });
  assert.equal(r.json<{ proto: string }>().proto, "https");
});

test("X-Forwarded-Proto is read case-insensitively as a header name", async () => {
  const lower = await app.inject({ url: "/here", headers: { "x-forwarded-proto": "https" } });
  const mixed = await app.inject({ url: "/here", headers: { "X-Forwarded-PROTO": "https" } });
  assert.equal(lower.json<{ proto: string }>().proto, "https");
  assert.equal(mixed.json<{ proto: string }>().proto, "https");
});

test("X-Forwarded-Proto value is passed through verbatim (no normalization)", async () => {
  const upper = await app.inject({ url: "/here", headers: { "x-forwarded-proto": "HTTPS" } });
  assert.equal(upper.json<{ proto: string }>().proto, "HTTPS");

  const list = await app.inject({ url: "/here", headers: { "x-forwarded-proto": "https, http" } });
  assert.equal(list.json<{ proto: string }>().proto, "https, http");
});

test("a present-but-empty X-Forwarded-Proto overrides the protocol to empty", async () => {
  const r = await app.inject({ url: "/here", headers: { "x-forwarded-proto": "" } });
  assert.equal(r.json<{ proto: string }>().proto, "");
});

test("without X-Forwarded-Proto the protocol defaults to http", async () => {
  assert.equal((await app.inject("/here")).json<{ proto: string }>().proto, "http");
});

test("hostname comes from the Host header with the port stripped", async () => {
  const r = await app.inject({ url: "/here", headers: { host: "example.com:8080" } });
  assert.equal(r.json<{ host: string }>().host, "example.com");
});

test("hostname keeps the bracketed IPv6 literal and drops the port", async () => {
  const r = await app.inject({ url: "/here", headers: { host: "[::1]:8080" } });
  assert.equal(r.json<{ host: string }>().host, "[::1]");
});

test("a Host header with no port is used as-is", async () => {
  const r = await app.inject({ url: "/here", headers: { host: "api.internal" } });
  assert.equal(r.json<{ host: string }>().host, "api.internal");
});

test("req.ip stays a stable non-empty loopback value across many requests", async () => {
  // every TCP request reuses the connection's cached IP string; assert consistency
  const ips = await Promise.all(
    Array.from({ length: 8 }, async () => (await app.inject("/here")).json<{ ip: string }>().ip),
  );
  assert.ok(ips.every((ip) => ip === ips[0] && ip !== ""));
});

test("req.headers stays a real Headers with get/iteration", async () => {
  const r = await app.inject({ url: "/hdrs", headers: { "user-agent": "toki-test", "x-a": "1" } });
  const b = r.json<{ isHeaders: boolean; ua: string; count: number }>();
  assert.equal(b.isHeaders, true);
  assert.equal(b.ua, "toki-test");
  assert.ok(b.count >= 2);
});

test("each request carries a distinct, non-empty req.id", async () => {
  const a = (await app.inject("/id")).json<{ id: string }>();
  const b = (await app.inject("/id")).json<{ id: string }>();
  assert.ok(a.id !== "" && a.id != null);
  assert.notEqual(a.id, b.id);
});

test("custom not-found handler runs with 404 and request context", async () => {
  const r = await app.inject({ method: "DELETE", url: "/nope/path" });
  assert.equal(r.statusCode, 404);
  const body = r.json<{ missing: string; method: string; ip: string }>();
  assert.equal(body.missing, "/nope/path");
  assert.equal(body.method, "DELETE");
  assert.match(body.ip, /\d|:/);
});

test("not-found dispatch still runs global onRequest hooks", async () => {
  await app.inject("/another/miss");
  assert.ok(seen.includes("/another/miss"));
});

test("custom not-found fires for every unmatched verb", async () => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const r = await app.inject({ method, url: "/ghost" });
    assert.equal(r.statusCode, 404, `${method} should reach the not-found handler`);
    assert.equal(r.json<{ missing: string }>().missing, "/ghost");
  }
});

test("not-found path excludes the query string", async () => {
  const r = await app.inject("/deep/nested/missing?ignored=1");
  assert.equal(r.statusCode, 404);
  assert.equal(r.json<{ missing: string }>().missing, "/deep/nested/missing");
});

test("a matched route does NOT invoke the not-found handler", async () => {
  const r = await app.inject("/here");
  assert.equal(r.statusCode, 200);
  assert.ok(r.json<{ proto: string }>().proto);
});

test("the not-found handler still sees req.ip when a proxy header is present", async () => {
  const r = await app.inject({ url: "/missing", headers: { "x-forwarded-proto": "https" } });
  assert.equal(r.statusCode, 404);
  assert.match(r.json<{ ip: string }>().ip, /\d|:/);
});

test("a wrong method on an existing route is 405, never the not-found handler", async () => {
  const r = await app.inject({ method: "POST", url: "/here" });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers["allow"], "GET");
});

test("the not-found handler can issue a redirect", async () => {
  const r = await app.inject("/nf/redirect");
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers["location"], "/login");
});

test("a throwing not-found handler routes through the error handler", async () => {
  const r = await app.inject("/nf/throw");
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.json(), { caught: "boom-in-nf" });
});
