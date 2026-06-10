import type { DocPage } from "../../types";

export const testingPage: DocPage = {
  slug: "testing",
  title: "Testing",
  description: "Drive your app in-process with app.inject().",
  blocks: [
    {
      kind: "paragraph",
      text: "`app.inject(options)` sends a request to your app over loopback, so the full native path runs (parse, route, middleware, handler, serialize) without binding a public port. It auto-binds an ephemeral port on `127.0.0.1` the first time you call it, then reuses it. The captured response is shaped after Fastify's `inject` result.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.test.ts",
        language: "ts",
        code: `import assert from "node:assert/strict";
import { test, after } from "node:test";
import { app } from "./app.ts";

after(() => app.close()); // free the auto-bound port when the file finishes

test("GET / returns ok", async () => {
  const res = await app.inject("/"); // a bare string is GET <url>
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "ok");
});

test("POST /users validates", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/users",
    payload: { name: "Ada" }, // object → JSON, sets content-type + length
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { created: "Ada" });
});`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "`app.close()` is the handle returned by `listen`. Calling `app.inject` once binds the port; close it in an `after` hook so the test process exits cleanly. Toki's engine is process-global, so test one app per process.",
    },
    { kind: "heading", id: "options", text: "InjectOptions" },
    {
      kind: "table",
      headers: ["Field", "Default", "Description"],
      rows: [
        ["`url`", '`"/"`', "Request path, with query string."],
        ["`method`", '`"GET"`', "HTTP method."],
        ["`headers`", "—", "Request headers as a plain object."],
        [
          "`payload`",
          "—",
          "A string or `Uint8Array` is sent as-is; any other value is JSON-encoded and sets `content-type: application/json`. `Content-Length` is filled in for you.",
        ],
      ],
    },
    {
      kind: "paragraph",
      text: 'A bare string is shorthand for a GET: `app.inject("/health")` equals `app.inject({ url: "/health" })`.',
    },
    { kind: "heading", id: "response", text: "The injected response" },
    {
      kind: "table",
      headers: ["Field", "Description"],
      rows: [
        ["`res.statusCode`", "The HTTP status."],
        ["`res.statusMessage`", "The status reason phrase."],
        ["`res.headers`", "Response headers (lowercased keys, Node style)."],
        ["`res.body`", "The body as a string (`res.payload` is an alias)."],
        ["`res.rawPayload`", "The body as a `Buffer` — use for binary responses."],
        ["`res.json<T>()`", "The body parsed as JSON."],
      ],
    },
    { kind: "heading", id: "headers", text: "Asserting headers & status" },
    {
      kind: "paragraph",
      text: "Send headers in, read headers out. This is how you test CORS, security headers, or a redirect.",
    },
    {
      kind: "code",
      snippet: {
        filename: "headers.test.ts",
        language: "ts",
        code: `import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "./app.ts";

test("CORS reflects an allowed origin", async () => {
  const res = await app.inject({
    url: "/api/me",
    headers: { origin: "https://app.example" },
  });
  assert.equal(res.headers["access-control-allow-origin"], "https://app.example");
});

test("redirect points home", async () => {
  const res = await app.inject("/old");
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers["location"], "/");
});`,
      },
    },
    { kind: "heading", id: "hooks", text: "Testing a guard or hook" },
    {
      kind: "paragraph",
      text: "Because inject drives the real pipeline, middleware and hooks run. Send a request that the guard should reject and assert the short-circuit; send a valid one and assert it passes through.",
    },
    {
      kind: "code",
      snippet: {
        filename: "auth.test.ts",
        language: "ts",
        code: `import assert from "node:assert/strict";
import { test } from "node:test";
import { signJwt } from "@usetoki/toki";
import { app } from "./app.ts";

test("rejects without a token", async () => {
  const res = await app.inject("/api/me");
  assert.equal(res.statusCode, 401);
});

test("accepts a valid token", async () => {
  const token = signJwt({ role: "admin" }, process.env.JWT_SECRET!, { subject: "u1" });
  const res = await app.inject({
    url: "/api/me",
    headers: { authorization: \`Bearer \${token}\` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ sub: string }>().sub, "u1");
});

test("unknown route 404s", async () => {
  const res = await app.inject("/nope");
  assert.equal(res.statusCode, 404);
});`,
      },
    },
    { kind: "heading", id: "fetch", text: "Or hit a real port with fetch" },
    {
      kind: "paragraph",
      text: "`inject` is enough for most tests. If you'd rather exercise the app through a real client (to test WebSockets, streaming, or a third-party HTTP library) listen on port `0` (the OS picks a free port) and `fetch` the returned `port`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "fetch.test.ts",
        language: "ts",
        code: `import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createApp } from "@usetoki/toki";

const app = createApp();
app.get("/ping", () => "pong");
const handle = app.listen(0); // ephemeral port
after(() => handle.close());

test("serves over a real socket", async () => {
  const res = await fetch(\`http://127.0.0.1:\${handle.port}/ping\`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "pong");
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Because inject runs a real request over loopback, your tests exercise the native parser, router, and serializer end to end, not a mock. What passes here behaves the same in production.",
    },
  ],
};
