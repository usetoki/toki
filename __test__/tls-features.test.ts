// Accept the self-signed loopback cert for the built-in WebSocket client too (test only).
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp, reply } from "../dist/index.js";
import { certFixture, makeHttps } from "./tls-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cert = certFixture("ec-cert.pem");
const key = certFixture("ec-key.pem");

async function* chunks(): AsyncGenerator<string> {
  for (const c of ["alpha-", "beta-", "gamma-", "delta"]) yield c;
}

const app = createApp({ logger: false });
app.get("/", () => reply.text("ok"));
app.get("/stream", () => reply.stream(chunks(), { contentType: "text/plain" }));
app.static("/assets", join(here, "fixtures", "www"));
app.ws("/ws", (socket) => {
  socket.on("message", (data, isBinary) => {
    socket.send(isBinary ? data : `echo:${data.toString()}`);
  });
});

const handle = app.listen(0, { host: "127.0.0.1", tls: { cert, key } });
const port = handle.port;
const https = makeHttps(port);
after(() => handle.close());

test("a chunked stream response round-trips over TLS", async () => {
  const r = await https({ path: "/stream" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "alpha-beta-gamma-delta");
});

test("a static file is served over TLS", async () => {
  const r = await https({ path: "/assets/hello.txt" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "static over tls\n");
});

test("HEAD over TLS returns headers with no body", async () => {
  const r = await https({ method: "HEAD", path: "/assets/hello.txt" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "");
  assert.ok(Number(r.headers["content-length"]) > 0);
});

test("a WebSocket echoes over wss (TLS)", async () => {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  const got = await new Promise<string>((resolve) => {
    ws.addEventListener("message", (e: MessageEvent) => resolve(String(e.data)));
    ws.send("hello");
  });
  assert.equal(got, "echo:hello");
  ws.close();
});

test("many wss messages round-trip on one connection", async () => {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  for (let i = 0; i < 10; i++) {
    const got = await new Promise<string>((resolve) => {
      const onMsg = (e: MessageEvent): void => {
        ws.removeEventListener("message", onMsg);
        resolve(String(e.data));
      };
      ws.addEventListener("message", onMsg);
      ws.send(`m${i}`);
    });
    assert.equal(got, `echo:m${i}`);
  }
  ws.close();
});
