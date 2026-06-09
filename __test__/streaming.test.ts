import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { createApp, reply } from "../ts/index.ts";
import { delay, freePort } from "./helpers.ts";

const app = createApp();

app.get("/sse", () =>
  reply.stream(
    (async function* () {
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        yield `data: msg${i}\n\n`;
      }
    })(),
    { contentType: "text/event-stream" },
  ),
);

app.get("/sync", () => reply.stream(["a", "b", "c"], { contentType: "text/plain" }));

app.get("/big", () =>
  reply.stream(
    (async function* () {
      const block = "x".repeat(64 * 1024);
      for (let i = 0; i < 16; i++) yield block;
    })(),
  ),
);

app.get("/boom", () =>
  reply.stream(
    (async function* () {
      yield "partial";
      throw new Error("mid-stream");
    })(),
  ),
);

app.get("/after", () => reply.text("after-ok"));

app.get("/default-ct", () => reply.stream(["one", "two"]));

app.get("/custom", () =>
  reply.stream(["body"], {
    status: 201,
    contentType: "text/plain",
    headers: [["X-Stream", "yes"]],
  }),
);

app.get("/staged", (req) => {
  req.setResponseHeader("X-Staged", "abc");
  return reply.stream(["data"], { contentType: "text/plain" });
});

app.get("/empty", () => reply.stream((async function* () {})(), { contentType: "text/plain" }));

app.get("/empty-chunks", () => reply.stream(["", "a", "", "b", ""], { contentType: "text/plain" }));

app.get("/bytes", () =>
  reply.stream(
    (async function* () {
      yield new Uint8Array([0x68, 0x69]);
      yield new Uint8Array([0x21]);
    })(),
    { contentType: "application/octet-stream" },
  ),
);

app.get("/mixed", () =>
  reply.stream(
    (async function* () {
      yield "A";
      yield new Uint8Array([0x42]);
      yield "C";
    })(),
    { contentType: "text/plain" },
  ),
);

app.get("/throw-first", () =>
  reply.stream(
    // eslint-disable-next-line require-yield
    (async function* (): AsyncGenerator<string> {
      throw new Error("immediate");
    })(),
    { contentType: "text/plain" },
  ),
);

app.get("/async-stream", async () => {
  await delay(5);
  return reply.stream(["lazy", "-", "stream"], { contentType: "text/plain" });
});

app.get("/slow-gen", () =>
  reply.stream(
    (async function* () {
      for (const part of ["p0", "p1", "p2", "p3"]) {
        await delay(2);
        yield part;
      }
    })(),
    { contentType: "text/plain" },
  ),
);

const port = await freePort();
const handle = app.listen(port, { host: "127.0.0.1" });
after(() => handle.close());

test("async generator streams as chunked SSE", async () => {
  const res = await app.inject("/sse");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["transfer-encoding"], "chunked");
  assert.match(String(res.headers["content-type"]), /text\/event-stream/);
  assert.equal(res.body, "data: msg0\n\ndata: msg1\n\ndata: msg2\n\n");
});

test("sync iterable streams", async () => {
  const res = await app.inject("/sync");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "abc");
});

test("large multi-chunk stream arrives intact", async () => {
  const res = await app.inject("/big");
  assert.equal(res.body.length, 16 * 64 * 1024);
  assert.match(res.body, /^x+$/);
});

test("a stream that throws still closes the response", async () => {
  const res = await app.inject("/boom");
  assert.equal(res.body, "partial");
  assert.equal(res.headers["transfer-encoding"], "chunked");
});

test("connection is reusable after a stream (keep-alive)", async () => {
  await app.inject("/sync");
  const res = await app.inject("/after");
  assert.equal(res.body, "after-ok");
});

test("a stream defaults to application/octet-stream content type", async () => {
  const res = await app.inject("/default-ct");
  assert.equal(res.body, "onetwo");
  assert.match(String(res.headers["content-type"]), /application\/octet-stream/);
});

test("a stream carries a custom status and custom headers", async () => {
  const res = await app.inject("/custom");
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["x-stream"], "yes");
  assert.equal(res.body, "body");
});

test("staged response headers prepend the stream header block", async () => {
  const res = await app.inject("/staged");
  assert.equal(res.headers["x-staged"], "abc");
  assert.equal(res.body, "data");
});

test("an empty async generator yields a valid empty chunked body", async () => {
  const res = await app.inject("/empty");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "");
  assert.equal(res.headers["transfer-encoding"], "chunked");
});

test("empty chunks are dropped, surrounding chunks survive", async () => {
  const res = await app.inject("/empty-chunks");
  assert.equal(res.body, "ab");
});

test("raw Uint8Array chunks pass through unchanged", async () => {
  const res = await app.inject("/bytes");
  assert.equal(res.body, "hi!");
  assert.deepEqual([...res.rawPayload], [0x68, 0x69, 0x21]);
});

test("a stream may mix string and byte chunks", async () => {
  const res = await app.inject("/mixed");
  assert.equal(res.body, "ABC");
});

test("a throw before the first chunk still produces a clean 200 with empty body", async () => {
  const res = await app.inject("/throw-first");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "");
  assert.equal(res.headers["transfer-encoding"], "chunked");
});

test("one failing stream does not poison a concurrent healthy one", async () => {
  const [bad, good] = await Promise.all([app.inject("/boom"), app.inject("/sse")]);
  assert.equal(bad.body, "partial");
  assert.equal(good.body, "data: msg0\n\ndata: msg1\n\ndata: msg2\n\n");
});

test("a promise resolving to a stream still streams", async () => {
  const res = await app.inject("/async-stream");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "lazy-stream");
});

test("an async generator awaiting between yields delivers every chunk in order", async () => {
  const res = await app.inject("/slow-gen");
  assert.equal(res.body, "p0p1p2p3");
});

test("many concurrent streams each return their own bytes", async () => {
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0
        ? app.inject("/sync").then((r) => r.body)
        : app.inject("/big").then((r) => r.body.length),
    ),
  );
  results.forEach((value, i) => {
    if (i % 2 === 0) assert.equal(value, "abc");
    else assert.equal(value, 16 * 64 * 1024);
  });
});

test("a single keep-alive socket serves a stream then a plain request in order", async () => {
  const sock = net.connect(port, "127.0.0.1");
  let data = "";
  await new Promise<void>((resolve, reject) => {
    sock.on("connect", () =>
      sock.write(
        "GET /sync HTTP/1.1\r\nHost: x\r\n\r\n" + "GET /after HTTP/1.1\r\nHost: x\r\n\r\n",
      ),
    );
    sock.on("data", (chunk) => {
      data += chunk;
      if (data.includes("after-ok")) {
        sock.end();
        resolve();
      }
    });
    sock.on("error", reject);
  });
  // chunked framing means "abc" never appears contiguously; find the terminator
  const streamEnd = data.indexOf("0\r\n\r\n");
  const afterAt = data.indexOf("after-ok");
  assert.ok(streamEnd !== -1 && afterAt !== -1, "both responses present");
  assert.ok(streamEnd < afterAt, "the stream response must precede the plain one");
  assert.match(data.slice(0, afterAt).toLowerCase(), /transfer-encoding: chunked/);
  assert.match(data.slice(afterAt - 200, afterAt), /content-length: 8/i);
});

test("a keep-alive socket survives an empty stream and keeps serving", async () => {
  const sock = net.connect(port, "127.0.0.1");
  let data = "";
  await new Promise<void>((resolve, reject) => {
    sock.on("connect", () =>
      sock.write(
        "GET /empty HTTP/1.1\r\nHost: x\r\n\r\n" + "GET /after HTTP/1.1\r\nHost: x\r\n\r\n",
      ),
    );
    sock.on("data", (chunk) => {
      data += chunk;
      if (data.includes("after-ok")) {
        sock.end();
        resolve();
      }
    });
    sock.on("error", reject);
  });
  assert.ok(data.includes("after-ok"), "request after an empty stream still answered");
});
