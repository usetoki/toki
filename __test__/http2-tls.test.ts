import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp, reply } from "../ts/index.ts";

// HTTP/2 over TLS, negotiated via ALPN ("h2"). Self-signed cert on loopback.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "rsa-cert.pem"));
const key = readFileSync(join(here, "fixtures", "rsa-key.pem"));

const app = createApp({ logger: false });
app.get("/", () => reply.text("tls h2"));
app.post("/up", (req) => reply.json({ len: req.body?.length ?? 0 }));
app.get("/down", () => reply.bytes(Buffer.alloc(1_200_000, 0x7a)));

const handle = app.listen(0, {
  host: "127.0.0.1",
  http2: true,
  tls: { cert, key },
  maxBodyBytes: 8 * 1024 * 1024,
});
const port = handle.port;
let client: http2.ClientHttp2Session;

before(() => {
  client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
});
after(() => {
  client.close();
  handle.close();
});

function req(
  headers: http2.OutgoingHttpHeaders,
  body?: Buffer,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = client.request(headers);
    const chunks: Buffer[] = [];
    let status = 0;
    r.on("response", (h) => (status = Number(h[":status"])));
    r.on("data", (d: Buffer) => chunks.push(d));
    r.on("end", () => resolve({ status, body: Buffer.concat(chunks) }));
    r.on("error", reject);
    body ? r.end(body) : r.end();
  });
}

test("ALPN negotiates h2", async () => {
  await req({ ":path": "/", ":method": "GET" });
  const alpn = (client.socket as { alpnProtocol?: string }).alpnProtocol;
  assert.equal(alpn, "h2");
});

test("GET over TLS", async () => {
  const r = await req({ ":path": "/", ":method": "GET" });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "tls h2");
});

test("3 MiB upload (receive flow control)", async () => {
  const up = Buffer.alloc(3 * 1024 * 1024, 0x62);
  const r = await req({ ":path": "/up", ":method": "POST" }, up);
  assert.equal(JSON.parse(r.body.toString()).len, up.length);
});

test("1.2 MiB download (send flow control, multi-window)", async () => {
  const r = await req({ ":path": "/down", ":method": "GET" });
  assert.equal(r.body.length, 1_200_000);
  assert.ok(r.body.every((b) => b === 0x7a));
});
