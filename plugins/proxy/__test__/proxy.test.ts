import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp } from "@usetoki/toki";
import { proxy } from "../src/index.ts";

// an upstream that echoes back what it received
const echo = (async (url: string | URL, init?: RequestInit) => {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : null;
  return new Response(JSON.stringify({ url: String(url), method: init?.method, headers, body }), {
    status: 200,
    headers: { "content-type": "application/json", "x-upstream": "hit" },
  });
}) as unknown as typeof fetch;

const notFound = (async () =>
  new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })) as typeof fetch;

const unreachable = (async () => {
  throw new Error("ECONNREFUSED");
}) as typeof fetch;

const app = createApp({ logger: false });
const gateway = proxy({ upstream: "http://up.test", fetch: echo });
app.get("/g", gateway);
app.post("/p", gateway);
app.get("/down", proxy({ upstream: "http://up.test", fetch: unreachable }));
app.get("/missing", proxy({ upstream: "http://up.test", fetch: notFound }));
app.get("/rw", proxy({ upstream: "http://up.test", fetch: echo, rewritePath: () => "/rewritten" }));
app.get(
  "/ssrf",
  proxy({ upstream: "http://up.test", fetch: echo, rewritePath: () => "http://evil.test/x" }),
);
app.get("/trust", proxy({ upstream: "http://up.test", fetch: echo, trustProxy: true }));

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

type Forwarded = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

test("forwards method, path, and query, and replays the upstream response", async () => {
  const res = await app.inject({ url: "/g?x=1" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-upstream"], "hit");
  const fwd = res.json() as Forwarded;
  assert.equal(fwd.url, "http://up.test/g?x=1");
  assert.equal(fwd.method, "GET");
});

test("adds the X-Forwarded-* chain", async () => {
  const fwd = (await app.inject({ url: "/g" })).json() as Forwarded;
  assert.ok("x-forwarded-for" in fwd.headers);
  assert.ok("x-forwarded-host" in fwd.headers);
  assert.equal(fwd.headers["x-forwarded-proto"], "http");
});

test("forwards the request body", async () => {
  const res = await app.inject({ method: "POST", url: "/p", payload: { a: 1 } });
  const fwd = res.json() as Forwarded;
  assert.equal(fwd.method, "POST");
  assert.equal(fwd.body, JSON.stringify({ a: 1 }));
});

test("does not forward hop-by-hop headers", async () => {
  const fwd = (
    await app.inject({ url: "/g", headers: { connection: "keep-alive" } })
  ).json() as Forwarded;
  assert.ok(!("connection" in fwd.headers));
  assert.ok(!("host" in fwd.headers));
});

test("an unreachable upstream becomes 502", async () => {
  assert.equal((await app.inject({ url: "/down" })).statusCode, 502);
});

test("the upstream status is preserved", async () => {
  assert.equal((await app.inject({ url: "/missing" })).statusCode, 404);
});

test("rewritePath maps the upstream path", async () => {
  const fwd = (await app.inject({ url: "/rw" })).json() as Forwarded;
  assert.equal(fwd.url, "http://up.test/rewritten");
});

test("a path that escapes the upstream origin is refused", async () => {
  assert.equal((await app.inject({ url: "/ssrf" })).statusCode, 502);
});

test("a client-supplied X-Forwarded-For is ignored by default", async () => {
  const fwd = (
    await app.inject({ url: "/g", headers: { "x-forwarded-for": "9.9.9.9" } })
  ).json() as Forwarded;
  assert.ok(!fwd.headers["x-forwarded-for"]!.includes("9.9.9.9")); // overwritten with the real peer
});

test("trustProxy appends to the X-Forwarded-For chain", async () => {
  const fwd = (
    await app.inject({ url: "/trust", headers: { "x-forwarded-for": "9.9.9.9" } })
  ).json() as Forwarded;
  assert.match(fwd.headers["x-forwarded-for"]!, /^9\.9\.9\.9, /);
});
