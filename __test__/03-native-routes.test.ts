import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { withServer, type RunningServer } from "./helpers";

describe("native routes", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer((app) => {
      app.native.text("/n/text", "plain native");
      app.native.html("/n/html", "<h1>native</h1>");
      app.native.json("/n/json", { ok: true, n: 1 });
      app.native.route("GET", "/n/version", "toki/1.0", {
        contentType: "text/plain; charset=utf-8",
        headers: { "cache-control": "no-store", "x-custom": "baked" },
      });
      app.native.route("DELETE", "/n/del", "deleted", { status: 202 });
    });
  });

  after(() => server.close());

  test("native.text serves the body with a text/plain content-type", async () => {
    const res = await fetch(`${server.base}/n/text`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await res.text(), "plain native");
  });

  test("native.html serves a text/html content-type", async () => {
    const res = await fetch(`${server.base}/n/html`);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await res.text(), "<h1>native</h1>");
  });

  test("native.json serves application/json with the serialized body", async () => {
    const res = await fetch(`${server.base}/n/json`);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await res.json(), { ok: true, n: 1 });
  });

  test("native.route bakes in custom headers and a custom content-type", async () => {
    const res = await fetch(`${server.base}/n/version`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-custom"), "baked");
    assert.equal(await res.text(), "toki/1.0");
  });

  test("native.route honors a custom status and method", async () => {
    const res = await fetch(`${server.base}/n/del`, { method: "DELETE" });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "deleted");
  });

  test("HEAD on a native GET returns 200, the GET's Content-Length, and zero body", async () => {
    // The native HEAD is the GET's head slice: same Content-Length, no body bytes.
    const res = await fetch(`${server.base}/n/text`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("content-length"), String("plain native".length));
    assert.equal(await res.text(), "");
  });

  test("HEAD on a native GET preserves baked-in headers", async () => {
    const res = await fetch(`${server.base}/n/version`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-custom"), "baked");
    assert.equal(res.headers.get("content-length"), String("toki/1.0".length));
    assert.equal(await res.text(), "");
  });

  test("a wrong method on a native GET is a native 404, not a 405", async () => {
    // Native routes live only in the exact-match table, never the dynamic router,
    // so a method miss falls through to a plain 404 (no Allow probing).
    const res = await fetch(`${server.base}/n/text`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("allow"), null);
    assert.equal(await res.text(), "Not Found");
  });
});
