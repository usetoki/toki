// run: node examples/rate-limit.ts

import assert from "node:assert/strict";
import { createApp } from "../ts/index.ts";

const app = createApp({ logger: false });

app.get("/ping", () => "pong");

const server = app.listen(0, { host: "127.0.0.1", rateLimit: { max: 3, windowMs: 60_000 } });

for (let i = 0; i < 3; i++) {
  const ok = await app.inject("/ping");
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, "pong");
}

const limited = await app.inject("/ping");
assert.equal(limited.statusCode, 429);
assert.equal(limited.body, "Too Many Requests");
assert.ok(limited.headers["retry-after"], "expected a Retry-After header");

server.close();
console.log("rate-limit ok");
process.exit(0);
