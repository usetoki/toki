import assert from "node:assert/strict";
import http2 from "node:http2";
import net from "node:net";
import { after, test } from "node:test";
import { createApp, reply } from "../ts/index.ts";

// Exclusive cleartext mode: the port speaks h2c only — a non-preface connection gets a
// GOAWAY and is closed, with no HTTP/1.1 fallback (for gRPC / pure-h2 deployments).
const app = createApp({ logger: false });
app.get("/", () => reply.text("h2c only"));
const handle = app.listen(0, { host: "127.0.0.1", http2: true, http2Cleartext: "exclusive" });
const port = handle.port;
after(() => handle.close());

test("a real h2c client is served", async () => {
  const c = http2.connect(`http://127.0.0.1:${port}`);
  const body = await new Promise<string>((resolve, reject) => {
    const r = c.request({ ":path": "/", ":method": "GET" });
    let b = "";
    r.setEncoding("utf8");
    r.on("data", (d) => (b += d));
    r.on("end", () => resolve(b));
    r.on("error", reject);
    r.end();
  });
  c.close();
  assert.equal(body, "h2c only");
});

test("a plain HTTP/1.1 connection gets GOAWAY and no 1.1 response", async () => {
  const buf = await new Promise<Buffer>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    s.on("connect", () => s.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    s.on("data", (d) => chunks.push(d));
    const done = () => {
      s.destroy();
      resolve(Buffer.concat(chunks));
    };
    s.on("close", done);
    s.on("error", done);
    setTimeout(done, 300);
  });
  // a GOAWAY frame (type 0x7) on stream 0, and never an HTTP/1.1 status line
  let goaway = false;
  for (let i = 0; i + 9 <= buf.length; ) {
    const len = buf.readUIntBE(i, 3);
    if (buf[i + 3] === 0x7) goaway = true;
    i += 9 + len;
  }
  assert.ok(goaway, "expected a GOAWAY frame");
  assert.ok(!buf.toString("latin1").includes("HTTP/1.1 2"), "must not fall back to HTTP/1.1");
});
