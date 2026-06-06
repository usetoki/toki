import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "../dist/index.js";

const app = createApp({ logger: false });
app.cors({ origin: "*", credentials: true });

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
app.post("/form", (req) => reply.json({ len: req.form?.files[0]?.data.length ?? -1 }));

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

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

test("a wildcard origin with credentials reflects the request origin (not *)", async () => {
  const res = await app.inject({
    url: "/schema",
    method: "OPTIONS",
    headers: { origin: "https://app.test" },
  });
  assert.equal(res.headers["access-control-allow-origin"], "https://app.test");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
});
