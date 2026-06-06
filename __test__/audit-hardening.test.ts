import assert from "node:assert/strict";
import { after, test } from "node:test";
import { corsHeaders, createApp, reply } from "../dist/index.js";

const app = createApp({ logger: false });
app.cors({ origin: ["https://app.test"], credentials: true });

app.post(
  "/schema",
  {
    schema: {
      body: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  () => reply.text("ok"),
);
app.get("/big-status", () => reply.json({ x: 1 }, 70000));
app.get("/three-digit-overflow", () => reply.text("x", 1000));
app.get("/zero-status", () => reply.text("x", 0));
app.post("/form", (req) => reply.json({ len: req.form?.files[0]?.data.length ?? -1 }));

// header value carrying CRLF must not split into extra headers on the wire
app.get("/crlf", (req) => {
  req.setResponseHeader("X-Inject", "ok\r\nX-Evil: 1");
  return reply.text("ok");
});
// a staged Content-Type overrides the reply default, but as a single header (no duplicate)
app.get("/ctype", (req) => {
  req.setResponseHeader("Content-Type", "text/custom");
  return reply.json({ ok: true });
});

app.post("/loose", { schema: { body: { type: "object", additionalProperties: false } } }, () =>
  reply.text("ok"),
);
app.post(
  "/nullable",
  { schema: { body: { type: "object", properties: { n: { type: "null" } } } } },
  () => reply.text("ok"),
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("a CRLF in a header value is stripped, not split into a second header", async () => {
  const res = await app.inject({ url: "/crlf" });
  assert.equal(res.headers["x-evil"], undefined);
  assert.equal(res.headers["x-inject"], "okX-Evil: 1");
});

test("a staged Content-Type overrides as a single header (no duplicate)", async () => {
  const res = await app.inject({ url: "/ctype" });
  assert.equal(res.headers["content-type"], "text/custom");
});

test("additionalProperties:false is enforced even with no declared properties", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/loose",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ anything: 1 }),
  });
  assert.equal(res.statusCode, 400);
});

test("type:null rejects a non-null value", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/nullable",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ n: 5 }),
  });
  assert.equal(res.statusCode, 400);
});

test("an out-of-range status (1000) or zero falls back to 500", async () => {
  assert.equal((await app.inject({ url: "/three-digit-overflow" })).statusCode, 500);
  assert.equal((await app.inject({ url: "/zero-status" })).statusCode, 500);
});

test("allow-credentials is withheld when the origin is not allowed", async () => {
  const res = await app.inject({ url: "/schema", headers: { origin: "https://evil.test" } });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
});

test("inherited prototype keys do not satisfy additionalProperties:false", async () => {
  const ok = await app.inject({
    method: "POST",
    url: "/schema",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "x" }),
  });
  assert.equal(ok.statusCode, 200);
  // "constructor"/"__proto__" are on Object.prototype — `in` would falsely allow them
  const bad = await app.inject({
    method: "POST",
    url: "/schema",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ constructor: "evil" }),
  });
  assert.equal(bad.statusCode, 400);
});

test("a status that overflows u16 is clamped to 500, not panicked/truncated", async () => {
  assert.equal((await app.inject({ url: "/big-status" })).statusCode, 500);
});

test("multipart data containing the boundary bytes is not truncated", async () => {
  const boundary = "----coreboundary";
  const payload = `AAAA--${boundary}BBBB`; // the boundary appears inside the file data
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\n\r\n${payload}\r\n` +
    `--${boundary}--\r\n`;
  const res = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal((res.json() as { len: number }).len, Buffer.byteLength(payload));
});

test("an allowlisted origin with credentials echoes that origin, never *", async () => {
  const res = await app.inject({
    url: "/schema",
    method: "OPTIONS",
    headers: { origin: "https://app.test" },
  });
  assert.equal(res.headers["access-control-allow-origin"], "https://app.test");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
});

test("wildcard origin combined with credentials is rejected at construction", () => {
  assert.throws(() => corsHeaders({ origin: "*", credentials: true }), /cannot be combined/);
});
