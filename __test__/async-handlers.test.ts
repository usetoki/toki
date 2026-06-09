import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { createApp, reply } from "../ts/index.ts";
import { delay, freePort } from "./helpers.ts";

const app = createApp({ requestTimeoutMs: 200 });

app.get("/sync", () => reply.text("sync"));

app.get("/async", async () => {
  await delay(20);
  return reply.text("async");
});

app.get("/slow", async () => {
  await delay(50);
  return reply.json({ ok: true });
});

// read body before awaiting: the native buffer recycles after the first await
app.post("/aecho", async (req) => {
  const body = req.text();
  await delay(10);
  return reply.text(body);
});

app.get("/boom", async () => {
  await delay(5);
  throw new Error("nope");
});

app.get("/async-string", async () => {
  await delay(10);
  return "plain-async";
});

app.get("/async-object", async () => {
  await delay(10);
  return { user: "ada", n: 42 };
});

app.get("/async-array", async () => {
  await delay(5);
  return [1, 2, 3];
});

app.get("/async-status", async () => {
  await delay(5);
  return reply.json({ created: true }, 201);
});

app.get("/reject", () => Promise.reject(new Error("rejected")));

app.get("/sync-throw", () => {
  throw new Error("sync-nope");
});

app.post("/parse-after-await", async (req) => {
  await delay(10);
  return reply.json(await req.parseBody());
});

app.post("/capture-before", async (req) => {
  const snapshot = {
    method: req.method,
    path: req.path,
    q: req.query.get("q"),
    body: req.text(),
  };
  await delay(15);
  return reply.json(snapshot);
});

app.get("/varydelay/:n", async (req) => {
  const n = Number(req.params.n);
  await delay(n % 7);
  return reply.text(`d${n}`);
});

app.register(
  (scope) => {
    scope.setErrorHandler((_req, err) =>
      reply.json({ caught: err instanceof Error ? err.message : String(err) }, 502),
    );
    scope.get("/fail", async () => {
      await delay(5);
      throw new Error("kaboom");
    });
  },
  { prefix: "/scoped" },
);

const port = await freePort();
const handle = app.listen(port, { host: "127.0.0.1" });
after(() => handle.close());

test("sync route still works alongside async ones", async () => {
  const res = await app.inject("/sync");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "sync");
});

test("async handler resolves", async () => {
  const res = await app.inject("/async");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "async");
});

test("async JSON", async () => {
  const res = await app.inject("/slow");
  assert.deepEqual(res.json(), { ok: true });
});

test("async reads body before awaiting", async () => {
  const res = await app.inject({ method: "POST", url: "/aecho", payload: "deferred-body" });
  assert.equal(res.body, "deferred-body");
});

test("throwing async handler yields 500", async () => {
  const res = await app.inject("/boom");
  assert.equal(res.statusCode, 500);
});

test("many concurrent async requests all resolve correctly", async () => {
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      app.inject({ method: "POST", url: "/aecho", payload: `n${i}` }).then((r) => r.body),
    ),
  );
  results.forEach((body, i) => assert.equal(body, `n${i}`));
});

test("pipelined async-then-sync preserves response order", async () => {
  const sock = net.connect(port, "127.0.0.1");
  let data = "";
  await new Promise<void>((resolve, reject) => {
    sock.on("connect", () =>
      sock.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\nGET /sync HTTP/1.1\r\nHost: x\r\n\r\n"),
    );
    sock.on("data", (chunk) => {
      data += chunk;
      if (data.includes("sync")) {
        sock.end();
        resolve();
      }
    });
    sock.on("error", reject);
  });
  const slowAt = data.indexOf('{"ok":true}');
  const syncAt = data.indexOf("sync");
  assert.ok(slowAt !== -1 && syncAt !== -1, "both responses present");
  assert.ok(slowAt < syncAt, "the slow (first) response must precede the sync one");
});

test("async resolving a bare string is sent as text/plain", async () => {
  const res = await app.inject("/async-string");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "plain-async");
  assert.match(String(res.headers["content-type"]), /text\/plain/);
});

test("async resolving a plain object is serialized as JSON", async () => {
  const res = await app.inject("/async-object");
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /application\/json/);
  assert.deepEqual(res.json(), { user: "ada", n: 42 });
});

test("async resolving an array is serialized as JSON", async () => {
  const res = await app.inject("/async-array");
  assert.deepEqual(res.json(), [1, 2, 3]);
});

test("async reply.json carries an explicit status code", async () => {
  const res = await app.inject("/async-status");
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { created: true });
});

test("parseBody works after an await", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/parse-after-await",
    payload: { a: 1, b: "x" },
  });
  assert.deepEqual(res.json(), { a: 1, b: "x" });
});

test("request fields captured before await echo back intact", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/capture-before?q=hello",
    payload: "the-body",
  });
  assert.deepEqual(res.json(), {
    method: "POST",
    path: "/capture-before",
    q: "hello",
    body: "the-body",
  });
});

test("empty body read before await yields empty string, not a crash", async () => {
  const res = await app.inject({ method: "POST", url: "/aecho" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "");
});

test("a large body survives the await boundary intact", async () => {
  const payload = "z".repeat(256 * 1024);
  const res = await app.inject({ method: "POST", url: "/aecho", payload });
  assert.equal(res.body.length, payload.length);
  assert.equal(res.body, payload);
});

test("a rejected promise (no throw) also yields 500", async () => {
  const res = await app.inject("/reject");
  assert.equal(res.statusCode, 500);
});

test("a synchronous throw before any await yields 500", async () => {
  const res = await app.inject("/sync-throw");
  assert.equal(res.statusCode, 500);
});

test("a custom (scoped) error handler shapes async failures", async () => {
  const res = await app.inject("/scoped/fail");
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { caught: "kaboom" });
});

test("one failing request does not poison its concurrent neighbours", async () => {
  const [bad, good] = await Promise.all([app.inject("/boom"), app.inject("/async")]);
  assert.equal(bad.statusCode, 500);
  assert.equal(good.statusCode, 200);
  assert.equal(good.body, "async");
});

test("interleaved variable-delay handlers each return their own value", async () => {
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      app.inject(`/varydelay/${i}`).then((r) => ({ i, body: r.body })),
    ),
  );
  for (const { i, body } of results) assert.equal(body, `d${i}`);
});

test("mixed sync and async requests resolve independently in one batch", async () => {
  const calls = Array.from({ length: 40 }, (_, i) =>
    i % 2 === 0 ? app.inject("/sync") : app.inject("/async"),
  );
  const bodies = (await Promise.all(calls)).map((r) => r.body);
  bodies.forEach((b, i) => assert.equal(b, i % 2 === 0 ? "sync" : "async"));
});

test("concurrent POSTs with distinct bodies never cross-wire", async () => {
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      app
        .inject({ method: "POST", url: "/capture-before?q=" + i, payload: `body-${i}` })
        .then((r) => r.json<{ q: string; body: string }>()),
    ),
  );
  results.forEach((r, i) => {
    assert.equal(r.q, String(i));
    assert.equal(r.body, `body-${i}`);
  });
});

test("three pipelined requests come back in request order despite varied delays", async () => {
  const sock = net.connect(port, "127.0.0.1");
  let data = "";
  await new Promise<void>((resolve, reject) => {
    sock.on("connect", () =>
      sock.write(
        "GET /slow HTTP/1.1\r\nHost: x\r\n\r\n" +
          "GET /async HTTP/1.1\r\nHost: x\r\n\r\n" +
          "GET /sync HTTP/1.1\r\nHost: x\r\n\r\n",
      ),
    );
    sock.on("data", (chunk) => {
      data += chunk;
      if (data.includes("sync")) {
        sock.end();
        resolve();
      }
    });
    sock.on("error", reject);
  });
  const slowAt = data.indexOf('{"ok":true}');
  const asyncAt = data.indexOf("async");
  const syncAt = data.indexOf("sync");
  assert.ok(slowAt !== -1 && asyncAt !== -1 && syncAt !== -1, "all three responses present");
  assert.ok(slowAt < asyncAt, "slow must precede async");
  assert.ok(asyncAt < syncAt, "async must precede sync");
});

test("pipelined order holds even when the first request fails", async () => {
  const sock = net.connect(port, "127.0.0.1");
  let data = "";
  await new Promise<void>((resolve, reject) => {
    sock.on("connect", () =>
      sock.write("GET /boom HTTP/1.1\r\nHost: x\r\n\r\n" + "GET /sync HTTP/1.1\r\nHost: x\r\n\r\n"),
    );
    sock.on("data", (chunk) => {
      data += chunk;
      if (data.includes("sync")) {
        sock.end();
        resolve();
      }
    });
    sock.on("error", reject);
  });
  const errAt = data.indexOf("500");
  const syncAt = data.indexOf("sync");
  assert.ok(errAt !== -1 && syncAt !== -1, "both the error and the sync response are present");
  assert.ok(errAt < syncAt, "the failed first response must still precede the sync one");
});
