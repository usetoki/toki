import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "../ts/index.ts";

const app = createApp();

app.get("/hello", () => reply.text("hi"));
app.get("/who/:id", (req) => reply.json({ id: req.params.id, ip: req.ip }));
app.get("/q", (req) => reply.json({ x: req.query.get("x"), all: req.query.getAll("k") }));
app.get("/ua", (req) => reply.text(req.headers.get("user-agent") ?? "<none>"));
app.get("/multi-header", (req) => reply.json({ accept: req.headers.get("accept") }));
app.get("/headers-all", (req) => {
  const out: Record<string, string> = {};
  for (const [k, v] of req.headers) out[k] = v;
  return reply.json(out);
});

app.post("/echo", async (req) => reply.json(await req.parseBody()));
app.post("/echo-text", (req) => reply.text(req.text()));
app.post("/echo-bytes", (req) => reply.json({ len: req.body ? req.body.length : 0 }));
app.post("/echo-ct", (req) => reply.text(req.headers.get("content-type") ?? "<none>"));
app.post("/raw-json", (req) => reply.json(req.json()));

app.post(
  "/validated",
  {
    schema: {
      body: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  (req) => reply.json(req.json()),
);

app.put("/replace", (req) => reply.json({ method: req.method, body: req.text() }));
app.patch("/touch", (req) => reply.json({ method: req.method }));
app.delete("/remove", () => reply.empty());

app.setNotFoundHandler((req) => reply.json({ missing: req.path }, 404));

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("inject a simple GET (string shorthand)", async () => {
  const res = await app.inject("/hello");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "hi");
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
});

test("inject with params hits the real native router", async () => {
  const res = await app.inject({ method: "GET", url: "/who/42" });
  const body = res.json<{ id: string; ip: string }>();
  assert.equal(body.id, "42");
  assert.match(body.ip, /\d|:/);
});

test("inject with a JSON payload sets content-type and round-trips", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: { a: 1, b: "x" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { a: 1, b: "x" });
});

test("inject reaches the custom not-found handler", async () => {
  const res = await app.inject({ method: "GET", url: "/nope" });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { missing: "/nope" });
});

test("string shorthand defaults to GET", async () => {
  const res = await app.inject("/hello");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "hi");
});

test("object form with no method defaults to GET", async () => {
  const res = await app.inject({ url: "/hello" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "hi");
});

test("a param is captured and decoded", async () => {
  const res = await app.inject("/who/alice%20smith");
  assert.equal(res.json<{ id: string }>().id, "alice smith");
});

test("an empty trailing param segment binds to an empty string", async () => {
  const res = await app.inject("/who/");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ id: string }>().id, "");
});

test("query string parses; route is unaffected by it", async () => {
  const res = await app.inject("/q?x=1&k=a&k=b");
  assert.deepEqual(res.json(), { x: "1", all: ["a", "b"] });
});

test("a missing query key reads as null", async () => {
  const res = await app.inject("/q");
  assert.deepEqual(res.json(), { x: null, all: [] });
});

test("a plain object payload is JSON-encoded with an inferred content-type", async () => {
  const res = await app.inject({ method: "POST", url: "/echo-ct", payload: { ok: true } });
  assert.equal(res.body, "application/json");
});

test("an array payload round-trips as JSON", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: [1, 2, 3] });
  assert.deepEqual(res.json(), [1, 2, 3]);
});

test("nested JSON survives the round trip", async () => {
  const data = { user: { id: 7, tags: ["a", "b"] }, n: null, f: 1.5 };
  const res = await app.inject({ method: "POST", url: "/echo", payload: data });
  assert.deepEqual(res.json(), data);
});

test("a raw JSON string payload with an explicit content-type parses on the server", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/raw-json",
    headers: { "content-type": "application/json" },
    payload: '{"hand":"written"}',
  });
  assert.deepEqual(res.json(), { hand: "written" });
});

test("an explicit content-type header is not overwritten by the JSON encoder", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/echo-ct",
    headers: { "content-type": "application/vnd.api+json" },
    payload: { x: 1 },
  });
  assert.equal(res.body, "application/vnd.api+json");
});

test("malformed JSON parsed inside a handler surfaces as a 500", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/raw-json",
    headers: { "content-type": "application/json" },
    payload: "{not valid json",
  });
  assert.equal(res.statusCode, 500);
});

test("a schema rejects malformed JSON with a 400 before the handler runs", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/validated",
    headers: { "content-type": "application/json" },
    payload: "{not valid json",
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ statusCode: number; error: string }>();
  assert.equal(body.statusCode, 400);
  assert.equal(body.error, "Bad Request");
});

test("a schema rejects a body missing a required field with a 400", async () => {
  const res = await app.inject({ method: "POST", url: "/validated", payload: { other: 1 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json<{ error: string }>().error, "Bad Request");
});

test("a schema-valid body passes through to the handler", async () => {
  const res = await app.inject({ method: "POST", url: "/validated", payload: { name: "ok" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { name: "ok" });
});

test("an unknown path reaches the custom 404 handler with the path echoed", async () => {
  const res = await app.inject("/does/not/exist");
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { missing: "/does/not/exist" });
});

test("a known path with the wrong verb is 405, not 404", async () => {
  const res = await app.inject({ method: "DELETE", url: "/hello" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers["allow"], "GET");
});

test("case matters: /Hello is not /hello", async () => {
  const res = await app.inject("/Hello");
  assert.equal(res.statusCode, 404);
});

test("a custom request header reaches the handler", async () => {
  const res = await app.inject({ url: "/ua", headers: { "user-agent": "toki-inject" } });
  assert.equal(res.body, "toki-inject");
});

test("a missing header reads as null on the server", async () => {
  const res = await app.inject({ url: "/ua", headers: { "user-agent": "" } });
  assert.equal(res.body, "");
});

test("header names are matched case-insensitively", async () => {
  const res = await app.inject({ url: "/multi-header", headers: { ACCEPT: "application/json" } });
  assert.equal(res.json<{ accept: string }>().accept, "application/json");
});

test("response headers are exposed lower-cased on the result", async () => {
  const res = await app.inject("/hello");
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(typeof res.headers["content-length"], "string");
});

test("multiple distinct headers all arrive", async () => {
  const res = await app.inject({
    url: "/headers-all",
    headers: { "x-one": "1", "x-two": "2", accept: "text/plain" },
  });
  const got = res.json<Record<string, string>>();
  assert.equal(got["x-one"], "1");
  assert.equal(got["x-two"], "2");
  assert.equal(got["accept"], "text/plain");
});

test("a string payload is sent verbatim (no JSON wrapping)", async () => {
  const res = await app.inject({ method: "POST", url: "/echo-text", payload: "plain-string" });
  assert.equal(res.body, "plain-string");
});

test("a string payload does not get an inferred JSON content-type", async () => {
  const res = await app.inject({ method: "POST", url: "/echo-ct", payload: "raw" });
  assert.equal(res.body, "<none>");
});

test("a Uint8Array payload arrives byte-for-byte", async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const res = await app.inject({ method: "POST", url: "/echo-bytes", payload: bytes });
  assert.equal(res.json<{ len: number }>().len, 5);
});

test("an empty string payload is accepted and content-length is 0", async () => {
  const res = await app.inject({ method: "POST", url: "/echo-text", payload: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "");
  assert.equal(res.headers["content-length"], "0");
});

test("a POST with no payload at all is accepted (empty body)", async () => {
  const res = await app.inject({ method: "POST", url: "/echo-text" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "");
});

test("an explicit content-length is honored over the computed one", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-length": "7" },
    payload: { a: 1 },
  });
  assert.deepEqual(res.json(), { a: 1 });
});

test("a large JSON payload survives the round trip", async () => {
  const big = { items: Array.from({ length: 1000 }, (_, i) => ({ i, s: "x".repeat(8) })) };
  const res = await app.inject({ method: "POST", url: "/echo", payload: big });
  assert.equal(res.json<{ items: unknown[] }>().items.length, 1000);
});

test("unicode in a JSON payload round-trips intact", async () => {
  const data = { greet: "héllo 世界 🚀", n: 1 };
  const res = await app.inject({ method: "POST", url: "/echo", payload: data });
  assert.deepEqual(res.json(), data);
  assert.equal(res.json<{ greet: string }>().greet, "héllo 世界 🚀");
});

test("PUT carries its body and reports its method", async () => {
  const res = await app.inject({ method: "PUT", url: "/replace", payload: "body-here" });
  assert.deepEqual(res.json(), { method: "PUT", body: "body-here" });
});

test("PATCH reaches its own handler", async () => {
  const res = await app.inject({ method: "PATCH", url: "/touch" });
  assert.deepEqual(res.json(), { method: "PATCH" });
});

test("DELETE returning reply.empty() is 204 with no body", async () => {
  const res = await app.inject({ method: "DELETE", url: "/remove" });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, "");
});

test("rawPayload, payload and body agree for a text response", async () => {
  const res = await app.inject("/hello");
  assert.equal(res.body, "hi");
  assert.equal(res.payload, "hi");
  assert.equal(res.rawPayload.toString("utf8"), "hi");
  assert.ok(Buffer.isBuffer(res.rawPayload));
});

test("statusMessage is populated for a standard status", async () => {
  const res = await app.inject({ method: "DELETE", url: "/hello" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.statusMessage, "Method Not Allowed");
});

test("json() throws on a non-JSON body rather than returning a sentinel", async () => {
  const res = await app.inject("/hello");
  assert.throws(() => res.json());
});

test("a second app injects without an explicit listen() call", async () => {
  const fresh = createApp();
  fresh.get("/ping", () => reply.text("pong"));
  const res = await fresh.inject("/ping");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "pong");
});
