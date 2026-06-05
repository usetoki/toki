// run: node examples/config-and-shutdown.ts

import assert from "node:assert/strict";
import { connect } from "node:net";
import { createApp } from "../dist/index.js";

const app = createApp({ logger: false });

let closed = false;
app.onClose(() => {
  closed = true;
});

app.post("/echo", (req) => ({ len: req.text().length }));

const port = 38217;
const server = app.listen(port, {
  host: "127.0.0.1",
  maxBodyBytes: 16,
  headerTimeoutMs: 500,
});

const ok = await app.inject({ method: "POST", url: "/echo", payload: "hi" });
assert.equal(ok.statusCode, 200);
assert.equal(ok.json<{ len: number }>().len, 2);

const big = await app.inject({
  method: "POST",
  url: "/echo",
  headers: { "content-type": "text/plain" },
  payload: "x".repeat(64),
});
assert.equal(big.statusCode, 413);

// raw socket: send partial headers (no terminating blank line) to trip headerTimeoutMs
const dropped = await new Promise<boolean>((resolve) => {
  const sock = connect(port, "127.0.0.1", () => {
    sock.write("GET /echo HTTP/1.1\r\nHost: localhost\r\n");
  });
  const timer = setTimeout(() => resolve(false), 3000);
  sock.on("close", () => {
    clearTimeout(timer);
    resolve(true);
  });
  sock.on("error", () => {});
});
assert.equal(dropped, true);

assert.equal(closed, false);
server.close();
assert.equal(closed, true);

console.log("config-and-shutdown ok");
process.exit(0);
