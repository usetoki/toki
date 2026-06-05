// run: node examples/compression.ts

import assert from "node:assert/strict";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { createApp, compression } from "../dist/index.js";

const app = createApp({ logger: false });

app.addHook("onResponse", compression({ threshold: 1024 }));

const body = "the quick brown fox jumps over the lazy dog. ".repeat(64);
app.get("/article", () => body);
app.get("/ping", () => "pong");

const br = await app.inject({ url: "/article", headers: { "accept-encoding": "br, gzip" } });
assert.equal(br.statusCode, 200);
assert.equal(br.headers["content-encoding"], "br");
assert.equal(br.headers["vary"], "Accept-Encoding");
assert.equal(brotliDecompressSync(br.rawPayload).toString("utf8"), body);
assert.ok(br.rawPayload.byteLength < Buffer.byteLength(body));

const gz = await app.inject({ url: "/article", headers: { "accept-encoding": "gzip" } });
assert.equal(gz.headers["content-encoding"], "gzip");
assert.equal(gunzipSync(gz.rawPayload).toString("utf8"), body);

const plain = await app.inject({ url: "/article" });
assert.equal(plain.headers["content-encoding"], undefined);
assert.equal(plain.body, body);

const small = await app.inject({ url: "/ping", headers: { "accept-encoding": "br" } });
assert.equal(small.headers["content-encoding"], undefined);
assert.equal(small.body, "pong");

console.log("compression ok");
process.exit(0);
