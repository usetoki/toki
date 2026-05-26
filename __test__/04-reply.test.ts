import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { reply } from "../ts";
import { withServer, type RunningServer } from "./helpers";

describe("reply helpers", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer((app) => {
      app.get("/text", () => reply.text("hello"));
      app.get("/text-status", () => reply.text("nope", { status: 404 }));
      app.get("/html", () => reply.html("<p>hi</p>"));
      app.get("/json", () => reply.json({ a: 1, b: [2, 3] }));
      app.get("/json-status", () => reply.json({ created: true }, { status: 201 }));
      app.get("/empty", () => reply.empty());
      app.get("/empty-205", () => reply.empty(205));
      app.get("/redirect", () => reply.redirect("/text"));
      app.get("/redirect-301", () => reply.redirect("/text", 301));
      app.get("/cookie", () => reply.cookie(reply.json({ ok: true }), "sid", "abc", { path: "/" }));
      app.get("/custom-ct", () =>
        reply.text("data", { headers: { "content-type": "application/x-custom" } }),
      );
    });
  });

  after(() => server.close());

  test("text defaults to 200 and text/plain", async () => {
    const res = await fetch(`${server.base}/text`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await res.text(), "hello");
  });

  test("text honors a custom status", async () => {
    const res = await fetch(`${server.base}/text-status`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "nope");
  });

  test("html sets a text/html content-type", async () => {
    const res = await fetch(`${server.base}/html`);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await res.text(), "<p>hi</p>");
  });

  test("json serializes the body and sets application/json", async () => {
    const res = await fetch(`${server.base}/json`);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await res.json(), { a: 1, b: [2, 3] });
  });

  test("json honors a custom status", async () => {
    const res = await fetch(`${server.base}/json-status`);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { created: true });
  });

  test("empty defaults to 204 with no content-type and an empty body", async () => {
    const res = await fetch(`${server.base}/empty`);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("content-type"), null);
    assert.equal(await res.text(), "");
  });

  test("empty honors a custom status", async () => {
    const res = await fetch(`${server.base}/empty-205`);
    assert.equal(res.status, 205);
    assert.equal(await res.text(), "");
  });

  test("redirect defaults to 302 with a Location header and no body", async () => {
    const res = await fetch(`${server.base}/redirect`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/text");
    assert.equal(await res.text(), "");
  });

  test("redirect honors a custom status", async () => {
    const res = await fetch(`${server.base}/redirect-301`, { redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/text");
  });

  test("reply.cookie appends a Set-Cookie and chains onto another helper", async () => {
    const res = await fetch(`${server.base}/cookie`);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get("set-cookie"), "sid=abc; Path=/");
  });

  test("a caller-supplied content-type is not overridden", async () => {
    const res = await fetch(`${server.base}/custom-ct`);
    assert.equal(res.headers.get("content-type"), "application/x-custom");
    assert.equal(await res.text(), "data");
  });
});
