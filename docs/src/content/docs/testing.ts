import type { DocPage } from "../../types";

export const testingPage: DocPage = {
  slug: "testing",
  title: "Testing",
  description: "Drive your app in-process with app.inject().",
  blocks: [
    {
      kind: "paragraph",
      text: "`app.inject(options)` sends a request in-process over loopback, so the full native path runs without binding a public port. It auto-binds an ephemeral port when the app is not already listening and returns the captured response.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.test.ts",
        language: "ts",
        code: `import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "./app.ts";

test("GET / returns ok", async () => {
  const res = await app.inject("/");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "ok");
});

test("POST /users validates", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/users",
    headers: { "content-type": "application/json" },
    payload: { name: "Ada" },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { created: "Ada" });
});`,
      },
    },
    { kind: "heading", id: "response", text: "The injected response" },
    {
      kind: "table",
      headers: ["Field", "Description"],
      rows: [
        ["`res.statusCode`", "The HTTP status."],
        ["`res.headers`", "Response headers."],
        ["`res.body`", "The body as a string."],
        ["`res.json<T>()`", "The body parsed as JSON."],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Because inject runs a real request over loopback, it exercises the native parser, router, and serializer — your tests cover the whole path, not a mock.",
    },
  ],
};
