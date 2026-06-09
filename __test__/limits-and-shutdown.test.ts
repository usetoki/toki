import assert from "node:assert/strict";
import net from "node:net";
import { after, before, test } from "node:test";
import { createApp, reply } from "../ts/index.ts";
import { freePort } from "./helpers.ts";

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

function closedWithin(sock: net.Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    sock.once("close", () => done(true));
    setTimeout(() => done(false), ms);
  });
}

function readResponse(sock: net.Socket, idleMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => resolve(buf), idleMs);
    };
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      arm();
    });
    sock.on("end", () => {
      clearTimeout(timer);
      resolve(buf);
    });
    arm();
  });
}

const MAX_BODY = 4096;
const HEADER_TIMEOUT = 600;

const app = createApp();
app.get("/", () => reply.text("ok"));
app.post("/echo", (req) => reply.text(String(req.body?.length ?? 0)));
app.get("/slow", async () => {
  await new Promise((r) => setTimeout(r, 80));
  return reply.text("finished");
});
const onCloseOrder: string[] = [];
app.onClose(() => {
  onCloseOrder.push("a");
});
app.onClose(() => {
  onCloseOrder.push("b");
});

let port = 0;
let handle: { close(): void };

before(async () => {
  port = await freePort();
  handle = app.listen(port, {
    host: "127.0.0.1",
    maxBodyBytes: MAX_BODY,
    headerTimeoutMs: HEADER_TIMEOUT,
  });
});

test("binds the configured host and serves the root route", async () => {
  const res = await app.inject("/");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "ok");
});

test("a body within the limit is accepted and fully delivered", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: "A".repeat(2048) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "2048");
});

test("a body at exactly maxBodyBytes is accepted (boundary)", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: "A".repeat(MAX_BODY) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, String(MAX_BODY));
});

test("one byte over the limit is rejected (boundary is a strict >)", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: "A".repeat(MAX_BODY + 1) });
  assert.equal(res.statusCode, 413);
});

test("a body far over maxBodyBytes is rejected with 413 Content Too Large", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: "A".repeat(8192) });
  assert.equal(res.statusCode, 413);
  assert.match(res.body, /Content Too Large/i);
});

test("an empty body is accepted (zero is within any limit)", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "0");
});

test("a connection that never finishes its headers is closed after the timeout", async () => {
  const sock = await connect(port);
  sock.write("GET / HTTP/1.1\r\nHost: x\r\n");
  const closed = await closedWithin(sock, 2500);
  sock.destroy();
  assert.ok(closed, "the server should drop a connection stalled past headerTimeoutMs");
});

test("a bare idle connection (zero bytes) is NOT reaped by the header guard", async () => {
  const sock = await connect(port);
  const closed = await closedWithin(sock, 1500);
  sock.destroy();
  assert.equal(closed, false, "a fully silent connection is not covered by headerTimeoutMs");
});

test("a slow-but-complete request still succeeds within the timeout", async () => {
  const sock = await connect(port);
  sock.write("GET / HTTP/1.1\r\n");
  await new Promise((r) => setTimeout(r, 200));
  sock.write("Host: x\r\n\r\n");
  const resp = await readResponse(sock, 400);
  sock.destroy();
  assert.match(resp, /^HTTP\/1\.1 200 OK/);
  assert.match(resp, /\r\n\r\nok$/);
});

test("a Content-Length with a leading '+' is rejected at the wire (smuggling guard)", async () => {
  // RFC 9112 Content-Length is 1*DIGIT; a '+5' that parseInt would accept could be read
  // differently by a front-end, opening a request-smuggling desync. The native parser
  // refuses any non-digit byte. inject() can't exercise this — it must hit the wire.
  const sock = await connect(port);
  sock.write("POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: +5\r\n\r\nAAAAA");
  const resp = await readResponse(sock, 400);
  sock.destroy();
  assert.match(resp, /^HTTP\/1\.1 400/, "a non-digit Content-Length must be a 400");
});

test("close() is a hard close — an in-flight request is severed, not drained", async () => {
  const inflight = fetch(`http://127.0.0.1:${port}/slow`)
    .then((r) => r.text())
    .catch(
      (err: { cause?: { code?: string }; code?: string }) => `ERR:${err.cause?.code ?? err.code}`,
    );
  await new Promise((r) => setTimeout(r, 20));
  handle.close();
  assert.equal(await inflight, "ERR:UND_ERR_SOCKET");
});

test("onClose hooks ran, in registration order, on close", () => {
  assert.deepEqual(onCloseOrder, ["a", "b"]);
});

test("after close the server stops accepting connections", async () => {
  await new Promise((r) => setTimeout(r, 150));
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/`),
    "the server should no longer accept connections after close()",
  );
});

test("calling close() again is idempotent and does not throw", async () => {
  assert.doesNotThrow(() => handle.close(), "a second close() must be a safe no-op");
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/`),
    "the server stays down after a double close",
  );
});

after(() => {
  try {
    handle.close();
  } catch {
    /* idempotent */
  }
});
