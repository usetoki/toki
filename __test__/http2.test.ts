import assert from "node:assert/strict";
import http2 from "node:http2";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp, reply } from "../ts/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

// HTTP/2 over cleartext (h2c prior knowledge) — no certs, so it runs anywhere. The TLS
// path (ALPN "h2") is covered in http2-tls.test.ts. One listen per process: this file is
// the h2c server, that file is the TLS server.
const app = createApp({ logger: false });
app.get("/", () => reply.text("hello h2"));
app.get("/json", (req) => reply.json({ path: req.path, q: req.query.get("q") }));
app.post("/echo", (req) => reply.bytes(req.body ?? new Uint8Array()));
app.get("/head", () => reply.bytes(Buffer.alloc(2048, 0x41)));
app.get("/cookies", (req) => reply.json({ a: req.cookies.a, b: req.cookies.b }));
app.get("/host", (req) => reply.json({ host: req.hostname }));
app.get("/async", async () => {
  await new Promise((r) => setTimeout(r, 5));
  return reply.text("async-ok");
});
app.get("/stream", () =>
  reply.stream(
    (async function* () {
      for (let i = 0; i < 200; i++) yield Buffer.alloc(1024, 0x62);
    })(),
  ),
);
app.static("/assets", join(here, "fixtures", "www"));

const handle = app.listen(0, { host: "127.0.0.1", http2: true });
const port = handle.port;
let client: http2.ClientHttp2Session;

before(() => {
  client = http2.connect(`http://127.0.0.1:${port}`);
});
after(() => {
  client.close();
  handle.close();
});

interface Res {
  status: number;
  headers: http2.IncomingHttpHeaders;
  body: Buffer;
}

function req(headers: http2.OutgoingHttpHeaders, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = client.request(headers);
    const chunks: Buffer[] = [];
    let h: http2.IncomingHttpHeaders = {};
    r.on("response", (hh) => (h = hh));
    r.on("data", (d: Buffer) => chunks.push(d));
    r.on("end", () =>
      resolve({ status: Number(h[":status"]), headers: h, body: Buffer.concat(chunks) }),
    );
    r.on("error", reject);
    body ? r.end(body) : r.end();
  });
}

test("GET returns a text body", async () => {
  const r = await req({ ":path": "/", ":method": "GET" });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "hello h2");
});

test("path and query are parsed", async () => {
  const r = await req({ ":path": "/json?q=hi", ":method": "GET" });
  assert.deepEqual(JSON.parse(r.body.toString()), { path: "/json", q: "hi" });
});

test("POST body round-trips", async () => {
  const payload = Buffer.from("the quick brown fox".repeat(200));
  const r = await req({ ":path": "/echo", ":method": "POST" }, payload);
  assert.equal(Buffer.compare(r.body, payload), 0);
});

test("empty POST body", async () => {
  const r = await req({ ":path": "/echo", ":method": "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 0);
});

test("HEAD sends content-length but no body", async () => {
  const r = await req({ ":path": "/head", ":method": "HEAD" });
  assert.equal(r.headers["content-length"], "2048");
  assert.equal(r.body.length, 0);
});

test("async handler resolves", async () => {
  const r = await req({ ":path": "/async", ":method": "GET" });
  assert.equal(r.body.toString(), "async-ok");
});

test("streaming response delivers every chunk", async () => {
  const r = await req({ ":path": "/stream", ":method": "GET" });
  assert.equal(r.body.length, 200 * 1024);
  assert.ok(r.body.every((b) => b === 0x62));
});

test("split cookie headers are rejoined", async () => {
  const r = await req({ ":path": "/cookies", ":method": "GET", cookie: ["a=1", "b=2"] });
  assert.deepEqual(JSON.parse(r.body.toString()), { a: "1", b: "2" });
});

test(":authority becomes req.hostname", async () => {
  const r = await req({ ":path": "/host", ":method": "GET", ":authority": "example.test" });
  assert.equal(JSON.parse(r.body.toString()).host, "example.test");
});

test("static files serve with an etag and 304", async () => {
  const r = await req({ ":path": "/assets/hello.txt", ":method": "GET" });
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
  const etag = r.headers["etag"] as string;
  assert.equal(typeof etag, "string");
  const nm = await req({ ":path": "/assets/hello.txt", ":method": "GET", "if-none-match": etag });
  assert.equal(nm.status, 304);
});

test("unknown route returns 404", async () => {
  const r = await req({ ":path": "/nope", ":method": "GET" });
  assert.equal(r.status, 404);
});

test("concurrent multiplexed streams stay independent", async () => {
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => req({ ":path": `/json?q=${i}`, ":method": "GET" })),
  );
  results.forEach((r, i) => assert.equal(JSON.parse(r.body.toString()).q, String(i)));
});
