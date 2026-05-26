import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { reply } from "../ts";
import { rawRequest, withServer, type RunningServer } from "./helpers";

describe("routing", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer((app) => {
      app.get("/", () => reply.text("root"));
      app.get("/users/:id", (req) => reply.json({ id: req.params.id ?? null }));
      app.get("/files/:dir/:name", (req) =>
        reply.json({ dir: req.params.dir ?? null, name: req.params.name ?? null }),
      );
      app.get("/search", (req) => reply.json(Object.fromEntries(req.query)));
      app.get("/verb", () => reply.text("GET"));
      app.post("/verb", () => reply.text("POST"));
      app.put("/verb", () => reply.text("PUT"));
      app.patch("/verb", () => reply.text("PATCH"));
      app.delete("/verb", () => reply.text("DELETE"));
      app.options("/verb", () => reply.text("OPTIONS"));
      app.route("PURGE", "/verb", () => reply.text("PURGE"));
      app.get("/assets/*", (req) => reply.json({ rest: req.params.wildcard ?? null }));
    });
  });

  after(() => server.close());

  test("matches a static root route", async () => {
    const res = await fetch(`${server.base}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "root");
  });

  test("captures a normal path param", async () => {
    const res = await fetch(`${server.base}/users/42`);
    assert.deepEqual(await res.json(), { id: "42" });
  });

  test("percent_decodes a path param", async () => {
    const res = await fetch(`${server.base}/users/a%20b%2Fc`);
    assert.deepEqual(await res.json(), { id: "a b/c" });
  });

  test("captures multiple params in declaration order", async () => {
    const res = await fetch(`${server.base}/files/docs/readme.txt`);
    assert.deepEqual(await res.json(), { dir: "docs", name: "readme.txt" });
  });

  test("a missing param segment is a native 404", async () => {
    const res = await fetch(`${server.base}/users`);
    assert.equal(res.status, 404);
    await res.body?.cancel();
  });

  test("parses the query string as repeated pairs", async () => {
    const res = await fetch(`${server.base}/search?q=toki&q=fast&limit=5`);
    // Object.fromEntries keeps the last value for a repeated key.
    assert.deepEqual(await res.json(), { q: "fast", limit: "5" });
  });

  test("decodes plus as space in the query", async () => {
    const res = await fetch(`${server.base}/search?phrase=hello+world`);
    assert.deepEqual(await res.json(), { phrase: "hello world" });
  });

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PURGE"]) {
    test(`dispatches the ${method} verb`, async () => {
      const res = await fetch(`${server.base}/verb`, { method });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), method);
    });
  }

  test("returns a native 404 with a Not Found body for an unknown path", async () => {
    const res = await fetch(`${server.base}/nope`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await res.text(), "Not Found");
  });

  test("returns a native 405 with a sorted Allow header for a known path, wrong method", async () => {
    // fetch/undici forbids TRACE, so craft the request on a raw socket.
    const raw = await rawRequest(
      server.port,
      "TRACE /verb HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    const text = raw.toString("latin1");
    const [head, body] = text.split("\r\n\r\n");
    assert.match(head ?? "", /^HTTP\/1\.1 405 Method Not Allowed/);
    const allowLine = (head ?? "").split("\r\n").find((l) => l.toLowerCase().startsWith("allow:"));
    const allow = (allowLine ?? "").slice("allow:".length).trim().split(", ");
    // Auto-HEAD adds HEAD alongside the explicit verbs; the list is sorted + deduped.
    assert.deepEqual(allow, [...allow].sort());
    assert.deepEqual(allow, ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PURGE", "PUT"]);
    assert.equal(body, "Method Not Allowed");
  });

  test("auto-HEAD on a dynamic GET runs the handler but sends an empty body and Content-Length 0", async () => {
    // The dynamic auto-HEAD drops the body in JS, so Content-Length is recomputed
    // to 0 (unlike a native HEAD, which keeps the GET's length).
    const res = await fetch(`${server.base}/`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "0");
    assert.equal(await res.text(), "");
  });

  test("a trailing slash does not match the canonical route", async () => {
    // normalizePattern canonicalizes the registered pattern, but the native router
    // matches the request path literally, so a trailing slash is a 404.
    const res = await fetch(`${server.base}/users/42/`);
    assert.equal(res.status, 404);
    await res.body?.cancel();
  });

  test("a wildcard route captures the remaining segments", async () => {
    const res = await fetch(`${server.base}/assets/css/site/app.css`);
    assert.deepEqual(await res.json(), { rest: "css/site/app.css" });
  });

  test("a wildcard route needs at least one trailing segment", async () => {
    // matchit's `{*wildcard}` requires >= 1 segment, so the bare prefix 404s.
    const res = await fetch(`${server.base}/assets`);
    assert.equal(res.status, 404);
    await res.body?.cancel();
  });
});
