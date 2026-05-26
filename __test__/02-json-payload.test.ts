import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { reply } from "../ts";
import { withServer, type RunningServer } from "./helpers";

interface Payload {
  readonly hello: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("json payload", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer((app) => {
      // Echoes parsed JSON; a parse failure becomes a clean 400 rather than a 500.
      app.post("/echo", (req) => {
        let body: unknown;
        try {
          body = req.json();
        } catch {
          return reply.json({ error: "invalid json" }, { status: 400 });
        }
        return reply.json({ received: body });
      });

      // Typed read plus a non-object guard.
      app.post("/object", (req) => {
        let body: unknown;
        try {
          body = req.json<Payload>();
        } catch {
          return reply.json({ error: "invalid json" }, { status: 400 });
        }
        if (!isRecord(body)) {
          return reply.json({ error: "expected object" }, { status: 400 });
        }
        return reply.json({ hello: body["hello"] ?? null });
      });

      app.post("/raw", (req) => reply.text(req.text()));
    });
  });

  after(() => server.close());

  test("parses a valid JSON object body", async () => {
    const res = await fetch(`${server.base}/echo`, {
      method: "POST",
      body: JSON.stringify({ hello: "world", nested: { n: 1 } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: { hello: "world", nested: { n: 1 } } });
  });

  test("malformed JSON is caught by the handler as a 400", async () => {
    const res = await fetch(`${server.base}/echo`, { method: "POST", body: "{not json" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid json" });
  });

  test("a JSON null parses but fails the object guard", async () => {
    const res = await fetch(`${server.base}/object`, { method: "POST", body: "null" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "expected object" });
  });

  test("a JSON array parses but fails the object guard", async () => {
    const res = await fetch(`${server.base}/object`, { method: "POST", body: "[1,2,3]" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "expected object" });
  });

  test("a JSON number parses but fails the object guard", async () => {
    const res = await fetch(`${server.base}/object`, { method: "POST", body: "42" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "expected object" });
  });

  test("an empty body is invalid JSON and yields 400", async () => {
    // req.text() returns "" for no body; JSON.parse("") throws.
    const res = await fetch(`${server.base}/echo`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid json" });
  });

  test("req.text() decodes the raw body as UTF-8", async () => {
    const res = await fetch(`${server.base}/raw`, { method: "POST", body: "héllo 世界" });
    assert.equal(await res.text(), "héllo 世界");
  });

  test("req.text() is empty when there is no body", async () => {
    const res = await fetch(`${server.base}/raw`, { method: "POST" });
    assert.equal(await res.text(), "");
  });
});
