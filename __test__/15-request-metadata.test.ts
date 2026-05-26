import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { reply } from "../ts";
import { withServer, type RunningServer } from "./helpers";

describe("request metadata", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer((app) => {
      app.get("/id", (req) => reply.json({ id: req.id }));
      app.post("/meta/:slug", (req) =>
        reply.json({
          method: req.method,
          path: req.path,
          slug: req.params.slug ?? null,
          isURLSearchParams: req.query instanceof URLSearchParams,
          queryAll: req.query.getAll("tag"),
          isHeaders: req.headers instanceof Headers,
          contentType: req.headers.get("content-type"),
        }),
      );
    });
  });

  after(() => server.close());

  test("req.id is 32-char lowercase hex", async () => {
    const res = await fetch(`${server.base}/id`);
    const { id } = (await res.json()) as { id: string };
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  test("req.id is unique per request", async () => {
    const [a, b] = await Promise.all([
      fetch(`${server.base}/id`).then((r) => r.json() as Promise<{ id: string }>),
      fetch(`${server.base}/id`).then((r) => r.json() as Promise<{ id: string }>),
    ]);
    assert.notEqual(a.id, b.id);
  });

  test("method, path, params, query, and headers are exposed with the right types", async () => {
    const res = await fetch(`${server.base}/meta/hello?tag=a&tag=b`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    assert.deepEqual(await res.json(), {
      method: "POST",
      path: "/meta/hello",
      slug: "hello",
      isURLSearchParams: true,
      queryAll: ["a", "b"],
      isHeaders: true,
      contentType: "text/plain",
    });
  });
});
