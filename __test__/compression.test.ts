import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compression, createApp, reply } from "../dist/index.js";

// inject() does not auto-decompress, so unwrap wire bytes ourselves.
const decode = (encoding: string | undefined, raw: Buffer): string => {
  if (encoding === "br") return brotliDecompressSync(raw).toString("utf8");
  if (encoding === "gzip") return gunzipSync(raw).toString("utf8");
  return raw.toString("utf8");
};

const CSS = "a{color:red}\n".repeat(400);
const root = mkdtempSync(join(tmpdir(), "toki-compress-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "assets", "big.css"), CSS);

const app = createApp({ logger: false });
app.static("/", root);
app.addHook("onResponse", compression({ threshold: 100 }));
app.get("/json", () => reply.json({ data: "x".repeat(5000) }));
app.get("/html", () => reply.html(`<main>${"y".repeat(5000)}</main>`));
app.get("/text", () => reply.text("z".repeat(5000)));
app.get("/bare", () => "w".repeat(5000));
app.get("/tiny", () => reply.text("tiny"));
app.get("/below", () => reply.text("b".repeat(99)));
app.get("/atOrAbove", () => reply.text("a".repeat(120)));
app.get("/png", () => reply.bytes(new Uint8Array(Array(5000).fill(65)), "image/png"));

let handle: { close(): void };
before(() => {
  handle = app.listen(0, { host: "127.0.0.1" });
});
after(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true });
});

test("static: brotli wins when offered, wire shrinks, content intact", async () => {
  const r = await app.inject({
    url: "/assets/big.css",
    headers: { "accept-encoding": "gzip, br" },
  });
  assert.equal(r.headers["content-encoding"], "br");
  assert.equal(r.headers["vary"], "Accept-Encoding");
  assert.ok(r.rawPayload.length < CSS.length, "compressed wire is smaller");
  assert.equal(decode("br", r.rawPayload), CSS);
});

test("static: gzip chosen when brotli not offered", async () => {
  const r = await app.inject({ url: "/assets/big.css", headers: { "accept-encoding": "gzip" } });
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(decode("gzip", r.rawPayload), CSS);
});

test("static: identity when only identity is accepted", async () => {
  const r = await app.inject({
    url: "/assets/big.css",
    headers: { "accept-encoding": "identity" },
  });
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.headers["content-length"], String(CSS.length));
  assert.equal(r.body, CSS);
});

test("static: no Accept-Encoding header serves identity", async () => {
  const r = await app.inject({ url: "/assets/big.css" });
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.body, CSS);
});

test("static: q=0 excludes brotli, falls back to gzip", async () => {
  const r = await app.inject({
    url: "/assets/big.css",
    headers: { "accept-encoding": "br;q=0, gzip" },
  });
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(decode("gzip", r.rawPayload), CSS);
});

test("static: q=0 on every coding falls back to identity", async () => {
  const r = await app.inject({
    url: "/assets/big.css",
    headers: { "accept-encoding": "br;q=0, gzip;q=0" },
  });
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.headers["content-length"], String(CSS.length));
});

test("static: wildcard accepts the preferred coding (brotli)", async () => {
  const r = await app.inject({ url: "/assets/big.css", headers: { "accept-encoding": "*" } });
  assert.equal(r.headers["content-encoding"], "br");
  assert.equal(decode("br", r.rawPayload), CSS);
});

test("static: brotli wins on preference, not on raw q-weight", async () => {
  const r = await app.inject({
    url: "/assets/big.css",
    headers: { "accept-encoding": "gzip;q=0.9, br;q=0.1" },
  });
  assert.equal(r.headers["content-encoding"], "br");
});

test("static: small files are not pre-compressed", async () => {
  const r = await app.inject({
    url: "/assets/style.css",
    headers: { "accept-encoding": "br, gzip" },
  });
  assert.equal(r.headers["content-encoding"], undefined);
});

test("static: 304 still negotiates a compressed resource", async () => {
  const first = await app.inject({ url: "/assets/big.css", headers: { "accept-encoding": "br" } });
  const etag = first.headers["etag"] as string;
  assert.ok(etag, "etag present on compressed resource");
  const second = await app.inject({
    url: "/assets/big.css",
    headers: { "accept-encoding": "br", "if-none-match": etag },
  });
  assert.equal(second.statusCode, 304);
  assert.equal(second.rawPayload.length, 0);
});

test("dynamic: reply.bytes serves a raw binary body unchanged", async () => {
  const r = await app.inject({ url: "/png", headers: { "accept-encoding": "br" } });
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.rawPayload.length, 5000);
  assert.deepEqual([...new Set(r.rawPayload)], [65]);
});

test("dynamic: large JSON is brotli-compressed and round-trips", async () => {
  const r = await app.inject({ url: "/json", headers: { "accept-encoding": "br" } });
  assert.equal(r.headers["content-encoding"], "br");
  assert.equal(r.headers["vary"], "Accept-Encoding");
  assert.ok(r.rawPayload.length < 5000, "wire is smaller than the body");
  assert.equal(JSON.parse(decode("br", r.rawPayload)).data.length, 5000);
});

test("dynamic: gzip used when brotli not offered", async () => {
  const r = await app.inject({ url: "/json", headers: { "accept-encoding": "gzip" } });
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(JSON.parse(decode("gzip", r.rawPayload)).data.length, 5000);
});

test("dynamic: text/html is compressible", async () => {
  const r = await app.inject({ url: "/html", headers: { "accept-encoding": "br" } });
  assert.equal(r.headers["content-encoding"], "br");
  assert.match(String(r.headers["content-type"]), /^text\/html/);
  assert.match(decode("br", r.rawPayload), /^<main>y+<\/main>$/);
});

test("dynamic: text/plain is compressible", async () => {
  const r = await app.inject({ url: "/text", headers: { "accept-encoding": "gzip" } });
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(decode("gzip", r.rawPayload).length, 5000);
});

test("dynamic: a bare-string handler (text/plain) is compressed", async () => {
  const r = await app.inject({ url: "/bare", headers: { "accept-encoding": "br" } });
  assert.equal(r.headers["content-encoding"], "br");
  assert.match(String(r.headers["content-type"]), /^text\/plain/);
  assert.equal(decode("br", r.rawPayload).length, 5000);
});

test("dynamic: small responses stay below threshold and are not compressed", async () => {
  const r = await app.inject({ url: "/tiny", headers: { "accept-encoding": "br, gzip" } });
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.headers["vary"], undefined);
  assert.equal(r.body, "tiny");
});

test("dynamic: identity-only request is left uncompressed", async () => {
  const r = await app.inject({ url: "/json", headers: { "accept-encoding": "identity" } });
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(r.body).data.length, 5000);
});

test("dynamic: missing Accept-Encoding is left uncompressed", async () => {
  const r = await app.inject({ url: "/json" });
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(r.body).data.length, 5000);
});

test("dynamic: q=0 excludes brotli, falls back to gzip", async () => {
  const r = await app.inject({ url: "/json", headers: { "accept-encoding": "br;q=0, gzip" } });
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(JSON.parse(decode("gzip", r.rawPayload)).data.length, 5000);
});

test("dynamic: q=0 on every coding leaves the body uncompressed", async () => {
  const r = await app.inject({ url: "/json", headers: { "accept-encoding": "br;q=0, gzip;q=0" } });
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(r.body).data.length, 5000);
});

test("dynamic: wildcard accepts the preferred coding (brotli)", async () => {
  const r = await app.inject({ url: "/json", headers: { "accept-encoding": "*" } });
  assert.equal(r.headers["content-encoding"], "br");
  assert.equal(JSON.parse(decode("br", r.rawPayload)).data.length, 5000);
});

test("dynamic: brotli wins on preference regardless of q-weight ordering", async () => {
  const r = await app.inject({
    url: "/json",
    headers: { "accept-encoding": "gzip;q=0.9, br;q=0.1" },
  });
  assert.equal(r.headers["content-encoding"], "br");
});

test("dynamic: threshold boundary — just-under stays raw, at-threshold compresses", async () => {
  const below = await app.inject({ url: "/below", headers: { "accept-encoding": "br" } });
  assert.equal(below.headers["content-encoding"], undefined);
  assert.equal(below.body.length, 99);

  const above = await app.inject({ url: "/atOrAbove", headers: { "accept-encoding": "br" } });
  assert.equal(above.headers["content-encoding"], "br");
  assert.equal(decode("br", above.rawPayload).length, 120);
});
