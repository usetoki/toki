// run: node examples/http2.ts
//
// HTTP/2 in the native engine. Set `http2: true` on `listen`; over TLS it is negotiated
// with ALPN ("h2"), falling back to HTTP/1.1 for clients that don't offer it. Multiplexing,
// flow control, and HPACK header compression all run in Zig — your handlers are unchanged.
// This mints a throwaway self-signed cert with openssl to stay self-contained.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http2 from "node:http2";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, reply } from "../ts/index.ts";

const dir = mkdtempSync(join(tmpdir(), "toki-h2-"));
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
} catch {
  console.log("skipped: openssl not available to mint a demo certificate");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const app = createApp({ logger: false });
app.get("/", () => reply.text("hello over http/2"));
app.get("/json", (req) => reply.json({ path: req.path, q: req.query.get("q") }));
// streaming works over h2 too: each chunk becomes a DATA frame under flow control
app.get("/stream", () =>
  reply.stream(
    (async function* () {
      for (let i = 0; i < 5; i++) yield `chunk ${i}\n`;
    })(),
    { contentType: "text/plain" },
  ),
);

const handle = app.listen(0, {
  host: "127.0.0.1",
  http2: true,
  tls: { cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) },
});

const client = http2.connect(`https://127.0.0.1:${handle.port}`, { rejectUnauthorized: false });

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = client.request({ ":path": path, ":method": "GET" });
    let status = 0;
    let body = "";
    req.on("response", (h) => (status = Number(h[":status"])));
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve({ status, body }));
    req.on("error", reject);
    req.end();
  });
}

const root = await get("/");
assert.equal(root.status, 200);
assert.equal(root.body, "hello over http/2");
assert.equal((client.socket as { alpnProtocol?: string }).alpnProtocol, "h2");
console.log(`ALPN negotiated h2; GET / -> ${root.body}`);

// fire several requests at once — they multiplex over the single connection
const many = await Promise.all([0, 1, 2].map((i) => get(`/json?q=${i}`)));
many.forEach((r, i) => assert.equal(JSON.parse(r.body).q, String(i)));
console.log("3 multiplexed requests ->", many.map((r) => r.body).join(" "));

const streamed = await get("/stream");
assert.equal(streamed.body, "chunk 0\nchunk 1\nchunk 2\nchunk 3\nchunk 4\n");
console.log("streamed ->", JSON.stringify(streamed.body));

client.close(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
  console.log("ok");
});
