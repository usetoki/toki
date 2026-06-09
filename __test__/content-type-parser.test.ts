import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, reply } from "../ts/index.ts";

const app = createApp({ logger: false });

app.addContentTypeParser("application/x-kv", (_req, body) => {
  const out: Record<string, string> = {};
  for (const pair of Buffer.from(body).toString("utf8").split(";")) {
    const [k, v] = pair.split(":");
    if (k && v !== undefined) out[k] = v;
  }
  return out;
});

app.addContentTypeParser("application/x-upper", async (_req, body) => {
  await Promise.resolve();
  return Buffer.from(body).toString("utf8").toUpperCase();
});

let probe: { path: string; len: number; isUint8: boolean } | null = null;
app.addContentTypeParser("application/x-probe", (req, body) => {
  probe = { path: req.path, len: body.length, isUint8: body instanceof Uint8Array };
  return "ok";
});

app.addContentTypeParser("text/count", (_req, body) => body.length);
app.addContentTypeParser(["application/a-one", "application/a-two"], () => "matched");
app.addContentTypeParser(/\+xml$/, (_req, body) => Buffer.from(body).toString("utf8").trim());

let onceCalls = 0;
app.addContentTypeParser("application/x-once", async (_req, body) => {
  onceCalls++;
  return Buffer.from(body).toString("utf8");
});

app.addContentTypeParser("application/x-dup", () => ({ which: "first" }));
app.addContentTypeParser("application/x-dup", () => ({ which: "second" }));

app.addContentTypeParser("application/x-boom", async () => {
  throw new Error("nope");
});

app.post("/echo", async (req) => reply.json({ parsed: await req.parseBody() }));

app.post("/shape", async (req) => {
  const parsed = await req.parseBody();
  if (parsed === undefined) return reply.text("undefined");
  if (parsed instanceof Uint8Array) return reply.json({ kind: "bytes", size: parsed.length });
  return reply.json({ kind: "value", value: parsed });
});

app.post("/once", async (req) => {
  const first = await req.parseBody();
  const second = await req.parseBody();
  return reply.json({ first, second, same: first === second });
});

app.register(
  (api) => {
    api.addContentTypeParser("application/x-kv", () => ({ overridden: true }));
    api.post("/echo", async (req) => reply.json({ parsed: await req.parseBody() }));
  },
  { prefix: "/v2" },
);

app.register(
  (api) => {
    api.post("/echo", async (req) => reply.json(await req.parseBody()));
  },
  { prefix: "/inherit" },
);

app.register(
  (api) => {
    api.addContentTypeParser("application/x-sib", () => ({ side: "A" }));
    api.post("/echo", async (req) => reply.json(await req.parseBody()));
  },
  { prefix: "/sib-a" },
);
app.register(
  (api) => {
    api.addContentTypeParser("application/x-sib", () => ({ side: "B" }));
    api.post("/echo", async (req) => reply.json(await req.parseBody()));
  },
  { prefix: "/sib-b" },
);

app.addContentTypeParser("application/x-depth", () => ({ at: "root" }));
app.register(
  (parent) => {
    parent.addContentTypeParser("application/x-depth", () => ({ at: "parent" }));
    parent.register(
      (child) => {
        child.addContentTypeParser("application/x-depth", () => ({ at: "child" }));
        child.post("/echo", async (req) => reply.json(await req.parseBody()));
      },
      { prefix: "/inner" },
    );
  },
  { prefix: "/outer" },
);

app.register(
  (api) => {
    api.addContentTypeParser("application/x-leak", () => ({ leaked: true }));
    api.post("/echo", async (req) => reply.json(await req.parseBody()));
  },
  { prefix: "/scoped" },
);

app.register(
  (api) => {
    api.addContentTypeParser("*", (_req, body) => ({ bytes: body.length }));
    api.post("/echo", async (req) => reply.json(await req.parseBody()));
  },
  { prefix: "/any" },
);

test("custom content-type parser feeds req.parseBody()", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/x-kv" },
    payload: "a:1;b:2",
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { parsed: { a: "1", b: "2" } });
});

test("async parser is awaited", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/x-upper" },
    payload: "hello",
  });
  assert.deepEqual(r.json(), { parsed: "HELLO" });
});

test("falls back to the JSON built-in when no custom parser matches", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: { x: 7 },
  });
  assert.deepEqual(r.json(), { parsed: { x: 7 } });
});

test("a scoped parser overrides the root for the same type", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/v2/echo",
    headers: { "content-type": "application/x-kv" },
    payload: "a:1",
  });
  assert.deepEqual(r.json(), { parsed: { overridden: true } });
});

test("custom parser matches as a prefix, tolerating a charset suffix", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/x-kv; charset=utf-8" },
    payload: "a:1;b:2",
  });
  assert.deepEqual(r.json(), { parsed: { a: "1", b: "2" } });
});

test("custom parser matching is case-insensitive on the header", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "APPLICATION/X-KV" },
    payload: "k:v",
  });
  assert.deepEqual(r.json(), { parsed: { k: "v" } });
});

test("custom parser is handed the request and the raw body bytes", async () => {
  probe = null;
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/x-probe" },
    payload: "abcde",
  });
  assert.deepEqual(r.json(), { parsed: "ok" });
  assert.deepEqual(probe, { path: "/echo", len: 5, isUint8: true });
});

test("custom parser can return a non-object value (a number)", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "text/count" },
    payload: "1234567",
  });
  assert.deepEqual(r.json(), { parsed: 7 });
});

test("an array of types registers one parser for each", async () => {
  for (const ct of ["application/a-one", "application/a-two"]) {
    const r = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": ct },
      payload: "x",
    });
    assert.deepEqual(r.json(), { parsed: "matched" }, ct);
  }
});

test("a RegExp type matches against the lowercased content-type", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/vnd.acme+xml" },
    payload: "<ok/>",
  });
  assert.deepEqual(r.json(), { parsed: "<ok/>" });
});

test("first matching parser wins over a later duplicate in the same scope", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/x-dup" },
    payload: "x",
  });
  assert.deepEqual(r.json(), { parsed: { which: "first" } });
});

test('a "*" wildcard parser captures every content-type, beating the built-ins', async () => {
  for (const ct of ["application/json", "text/plain", "application/octet-stream"]) {
    const r = await app.inject({
      method: "POST",
      url: "/any/echo",
      headers: { "content-type": ct },
      payload: "abc",
    });
    assert.deepEqual(r.json(), { bytes: 3 }, ct);
  }
});

test("a rejecting async parser surfaces as a 500", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/x-boom" },
    payload: "x",
  });
  assert.equal(r.statusCode, 500);
});

test("parseBody() is cached: an async parser runs only once across reads", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/once",
    headers: { "content-type": "application/x-once" },
    payload: "v",
  });
  assert.deepEqual(r.json(), { first: "v", second: "v", same: true });
  assert.equal(onceCalls, 1);
});

test("JSON fallback also fires for a +json suffix type", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/vnd.api+json" },
    payload: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(r.json(), { parsed: { ok: true } });
});

test("JSON fallback parses an array body", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify([1, 2, 3]),
  });
  assert.deepEqual(r.json(), { parsed: [1, 2, 3] });
});

test("malformed JSON in the fallback surfaces as a 500 (not silently swallowed)", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: "{ not json",
  });
  assert.equal(r.statusCode, 500);
});

test("text/* fallback yields a string", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "text/plain" },
    payload: "plain words",
  });
  assert.deepEqual(r.json(), { parsed: "plain words" });
});

test("an unknown content-type falls through to raw bytes", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/shape",
    headers: { "content-type": "application/x-unmatched" },
    payload: new TextEncoder().encode("abcde"),
  });
  assert.deepEqual(r.json(), { kind: "bytes", size: 5 });
});

test("an empty body yields undefined without consulting any parser", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/shape",
    headers: { "content-type": "application/x-kv" },
  });
  assert.equal(r.body, "undefined");
});

test("a scope inherits the root parser when it registers none of its own", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/inherit/echo",
    headers: { "content-type": "application/x-kv" },
    payload: "a:1",
  });
  assert.deepEqual(r.json(), { a: "1" });
});

test("a parser registered in a child scope does not leak to the root", async () => {
  const child = await app.inject({
    method: "POST",
    url: "/scoped/echo",
    headers: { "content-type": "application/x-leak" },
    payload: "x",
  });
  assert.deepEqual(child.json(), { leaked: true });

  const root = await app.inject({
    method: "POST",
    url: "/shape",
    headers: { "content-type": "application/x-leak" },
    payload: new TextEncoder().encode("xy"),
  });
  assert.deepEqual(root.json(), { kind: "bytes", size: 2 });
});

test("sibling scopes keep independent parser tables", async () => {
  const ra = await app.inject({
    method: "POST",
    url: "/sib-a/echo",
    headers: { "content-type": "application/x-sib" },
    payload: "x",
  });
  const rb = await app.inject({
    method: "POST",
    url: "/sib-b/echo",
    headers: { "content-type": "application/x-sib" },
    payload: "x",
  });
  assert.deepEqual(ra.json(), { side: "A" });
  assert.deepEqual(rb.json(), { side: "B" });
});

test("a nested grandchild scope overrides both parent and root", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/outer/inner/echo",
    headers: { "content-type": "application/x-depth" },
    payload: "x",
  });
  assert.deepEqual(r.json(), { at: "child" });
});
