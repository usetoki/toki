import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { createApp, reply } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer => readFileSync(join(here, "fixtures", name));
const cert = fixture("ec-cert.pem");
const key = fixture("ec-key.pem");

const BIG = "x".repeat(100_000); // forces a multi-record TLS response

const app = createApp({ logger: false });
app.get("/", () => reply.text("hello over tls"));
app.get("/json", (req) => reply.json({ ok: true, path: req.path, q: req.query.get("q") }));
app.post("/echo", (req) => reply.text(req.text()));
app.post("/size", (req) => reply.json({ len: req.text().length }));
app.get("/big", () => reply.text(BIG));
app.get("/boom", () => {
  throw new Error("kaboom");
});
app.get("/async", async () => {
  await new Promise((r) => setTimeout(r, 5));
  return reply.text("async-tls");
});

const handle = app.listen(0, { host: "127.0.0.1", tls: { cert, key } });
const port = handle.port;
after(() => handle.close());

interface Res {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
  alpn: string | false;
  tlsVersion: string | null;
}

function https(opts: {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
  agent?: Agent;
}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(opts.body));
    }
    const requestOptions = {
      host: "127.0.0.1",
      port,
      method: opts.method ?? "GET",
      path: opts.path,
      rejectUnauthorized: false, // self-signed test cert on loopback
      ALPNProtocols: ["http/1.1"],
      headers,
      ...(opts.agent ? { agent: opts.agent } : {}),
    } as RequestOptions & { ALPNProtocols: string[] };
    const req = httpsRequest(requestOptions, (res) => {
      const socket = res.socket as TLSSocket;
      const alpn = socket.alpnProtocol ?? false;
      const tlsVersion = socket.getProtocol?.() ?? null;
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: data,
          alpn,
          tlsVersion,
        }),
      );
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

test("GET over HTTPS", async () => {
  const r = await https({ path: "/" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "hello over tls");
});

test("the handshake negotiates TLS 1.3 and ALPN http/1.1", async () => {
  const r = await https({ path: "/" });
  assert.equal(r.alpn, "http/1.1");
  assert.equal(r.tlsVersion, "TLSv1.3");
});

test("JSON + query string over HTTPS", async () => {
  const r = await https({ path: "/json?q=hi" });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, path: "/json", q: "hi" });
});

test("POST body round-trips over HTTPS", async () => {
  const r = await https({ method: "POST", path: "/echo", body: "ping-tls" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "ping-tls");
});

test("a large response spans multiple TLS records intact", async () => {
  const r = await https({ path: "/big" });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, BIG.length);
  assert.equal(r.body, BIG);
});

test("a large request body spans multiple TLS records intact", async () => {
  const payload = "a".repeat(60_000); // > one record, exercises decrypt + growForBody
  const r = await https({ method: "POST", path: "/size", body: payload });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { len: payload.length });
});

test("unknown route is a 404 over HTTPS", async () => {
  const r = await https({ path: "/nope" });
  assert.equal(r.status, 404);
});

test("a thrown handler is a 500 over HTTPS", async () => {
  const r = await https({ path: "/boom" });
  assert.equal(r.status, 500);
});

test("an async handler resolves over HTTPS", async () => {
  const r = await https({ path: "/async" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "async-tls");
});

test("keep-alive reuses one TLS connection for many requests", async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
  for (let i = 0; i < 5; i++) {
    const r = await https({ path: "/json", agent });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
  }
  agent.destroy();
});

test("concurrent HTTPS connections all succeed", async () => {
  const results = await Promise.all(Array.from({ length: 24 }, () => https({ path: "/" })));
  assert.ok(results.every((r) => r.status === 200 && r.body === "hello over tls"));
});
