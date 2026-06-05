import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp, reply } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "toki-static-"));
const BIG = 1024 * 1024;
const MIME_FILES = ["a.woff2", "b.wasm", "c.svg", "d.mp4", "e.json", "f.pdf", "g.webp", "h.xyz"];

before(() => {
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, "nested", "deep"), { recursive: true });
  mkdirSync(join(root, "noindex"), { recursive: true });

  writeFileSync(join(root, "index.html"), "<!doctype html><h1>home</h1>");
  writeFileSync(join(root, "assets", "style.css"), "body{color:red}");
  writeFileSync(join(root, "assets", "app.css"), "/* shadowed */");
  writeFileSync(join(root, "nested", "deep", "leaf.txt"), "leaf");
  writeFileSync(join(root, "nested", "index.html"), "<h1>nested home</h1>");
  writeFileSync(join(root, "noindex", "page.html"), "<h1>page</h1>");
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(root, "big.bin"), Buffer.alloc(BIG, 0x41));
  writeFileSync(join(root, "oversized.bin"), Buffer.alloc(64 * 1024, 0x42));

  // one file per extension to check MIME-by-extension; content is irrelevant
  mkdirSync(join(root, "mime"));
  for (const name of MIME_FILES) writeFileSync(join(root, "mime", name), "x");
});

after(() => rmSync(root, { recursive: true, force: true }));

const app = createApp();
app.get("/api/ping", () => reply.json({ ok: true }));
app.get("/api/echo/:id", (req) => reply.json({ id: req.params.id }));
app.get("/assets/app.css", () => reply.text("ROUTE WINS"));
app.static("/", root);
app.static("/cdn", join(root, "assets"), { cacheControl: "public, max-age=600, immutable" });
app.static("/raw", join(root, "noindex"), { index: false });
app.static("/capped", root, { maxFileBytes: 1024 });
app.static("/mime", join(root, "mime"));

test("serves a file with content-type, cache-control, etag, and exact body", async () => {
  const r = await app.inject({ url: "/assets/style.css" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "text/css; charset=utf-8");
  assert.match(String(r.headers["cache-control"]), /max-age/);
  assert.ok(r.headers["etag"]);
  assert.equal(r.body, "body{color:red}");
  assert.equal(r.headers["content-length"], "15");
});

test("serves a nested file deep in the tree", async () => {
  const r = await app.inject({ url: "/nested/deep/leaf.txt" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "leaf");
  assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
});

test("serves a zero-byte file with content-length 0", async () => {
  const r = await app.inject({ url: "/empty.txt" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-length"], "0");
  assert.equal(r.body, "");
});

test("a custom mount applies its own cache-control", async () => {
  const r = await app.inject({ url: "/cdn/style.css" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "body{color:red}");
  assert.equal(r.headers["cache-control"], "public, max-age=600, immutable");
});

test("the same file is reachable under two mounts independently", async () => {
  const viaRoot = await app.inject({ url: "/assets/style.css" });
  const viaCdn = await app.inject({ url: "/cdn/style.css" });
  assert.equal(viaRoot.body, viaCdn.body);
  assert.notEqual(viaRoot.headers["cache-control"], viaCdn.headers["cache-control"]);
});

test("resolves mime types from extension", async () => {
  const cases: Array<[string, string]> = [
    ["/mime/a.woff2", "font/woff2"],
    ["/mime/b.wasm", "application/wasm"],
    ["/mime/c.svg", "image/svg+xml; charset=utf-8"],
    ["/mime/d.mp4", "video/mp4"],
    ["/mime/e.json", "application/json; charset=utf-8"],
    ["/mime/f.pdf", "application/pdf"],
    ["/mime/g.webp", "image/webp"],
  ];
  for (const [url, type] of cases) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 200, url);
    assert.equal(r.headers["content-type"], type, url);
  }
});

test("an unknown extension falls back to application/octet-stream", async () => {
  const r = await app.inject({ url: "/mime/h.xyz" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "application/octet-stream");
});

test("index.html answers the root directory URL", async () => {
  const slash = await app.inject({ url: "/" });
  const named = await app.inject({ url: "/index.html" });
  assert.match(slash.body, /home/);
  assert.match(named.body, /home/);
  assert.equal(slash.body, named.body);
});

test("index.html answers a subdirectory URL with and without trailing slash", async () => {
  const noSlash = await app.inject({ url: "/nested" });
  const withSlash = await app.inject({ url: "/nested/" });
  const named = await app.inject({ url: "/nested/index.html" });
  assert.match(noSlash.body, /nested home/);
  assert.match(withSlash.body, /nested home/);
  assert.equal(noSlash.body, named.body);
  assert.equal(withSlash.body, named.body);
});

test("index:false leaves the directory URL unserved but keeps real files", async () => {
  const dir = await app.inject({ url: "/raw" });
  const dirSlash = await app.inject({ url: "/raw/" });
  const file = await app.inject({ url: "/raw/page.html" });
  assert.equal(dir.statusCode, 404);
  assert.equal(dirSlash.statusCode, 404);
  assert.equal(file.statusCode, 200);
  assert.match(file.body, /page/);
});

test("matching If-None-Match returns 304 with an empty body", async () => {
  const first = await app.inject({ url: "/assets/style.css" });
  const etag = String(first.headers["etag"]);
  const second = await app.inject({ url: "/assets/style.css", headers: { "if-none-match": etag } });
  assert.equal(second.statusCode, 304);
  assert.equal(second.body, "");
});

test("a stale If-None-Match still serves 200 with the body", async () => {
  const r = await app.inject({
    url: "/assets/style.css",
    headers: { "if-none-match": '"stale-0"' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "body{color:red}");
});

test("If-None-Match: * always matches and returns 304", async () => {
  const r = await app.inject({ url: "/assets/style.css", headers: { "if-none-match": "*" } });
  assert.equal(r.statusCode, 304);
  assert.equal(r.body, "");
});

test("a weak validator (W/) matches the strong etag and returns 304", async () => {
  const first = await app.inject({ url: "/assets/style.css" });
  const weak = `W/${first.headers["etag"]}`;
  const r = await app.inject({ url: "/assets/style.css", headers: { "if-none-match": weak } });
  assert.equal(r.statusCode, 304);
});

test("a comma list of etags matches if any member matches", async () => {
  const first = await app.inject({ url: "/assets/style.css" });
  const list = `"nope", ${first.headers["etag"]}, "other"`;
  const r = await app.inject({ url: "/assets/style.css", headers: { "if-none-match": list } });
  assert.equal(r.statusCode, 304);
});

test("etag is stable across requests for an unchanged file", async () => {
  const a = await app.inject({ url: "/assets/style.css" });
  const b = await app.inject({ url: "/assets/style.css" });
  assert.equal(a.headers["etag"], b.headers["etag"]);
  assert.ok(/^"[0-9a-f]+-[0-9a-f]+"$/.test(String(a.headers["etag"])));
});

test("HEAD returns headers and content-length but no body", async () => {
  const r = await app.inject({ method: "HEAD", url: "/assets/style.css" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-length"], "15");
  assert.equal(r.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(r.rawPayload.length, 0);
});

test("HEAD honours If-None-Match and returns 304 without a body", async () => {
  const probe = await app.inject({ method: "HEAD", url: "/assets/style.css" });
  const r = await app.inject({
    method: "HEAD",
    url: "/assets/style.css",
    headers: { "if-none-match": String(probe.headers["etag"]) },
  });
  assert.equal(r.statusCode, 304);
  assert.equal(r.rawPayload.length, 0);
});

test("HEAD on the index URL works like GET sans body", async () => {
  const r = await app.inject({ method: "HEAD", url: "/" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.rawPayload.length, 0);
  assert.ok(Number(r.headers["content-length"]) > 0);
});

test("an explicit route shadows a static file at the same URL", async () => {
  const r = await app.inject({ url: "/assets/app.css" });
  assert.equal(r.body, "ROUTE WINS");
});

test("dynamic routes coexist with static mounts", async () => {
  assert.deepEqual((await app.inject({ url: "/api/ping" })).json(), { ok: true });
  assert.deepEqual((await app.inject({ url: "/api/echo/42" })).json(), { id: "42" });
});

test("static files are served for paths without a matching route", async () => {
  const r = await app.inject({ url: "/assets/style.css" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "body{color:red}");
});

test("an unregistered static path is 404", async () => {
  assert.equal((await app.inject({ url: "/missing.css" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/assets/missing.css" })).statusCode, 404);
});

test("a directory URL without an index file is 404, not a listing", async () => {
  const r = await app.inject({ url: "/assets" });
  assert.equal(r.statusCode, 404);
  assert.doesNotMatch(r.body, /style\.css/);
});

test("encoded traversal sequences do not escape the mount", async () => {
  for (const url of [
    "/..%2f..%2fpackage.json",
    "/assets/..%2f..%2fpackage.json",
    "/%2e%2e/%2e%2e/package.json",
    "/assets/%2e%2e%2fapp.css",
  ]) {
    const r = await app.inject({ url });
    assert.notEqual(r.statusCode, 200, url);
    assert.doesNotMatch(r.body, /"name"\s*:/, url);
  }
});

test("a null-byte in the path does not smuggle a different file", async () => {
  const r = await app.inject({ url: "/assets/style.css%00.png" });
  assert.notEqual(r.statusCode, 200);
});

test("the source tree above the mount is unreachable", async () => {
  for (const url of ["/index.ts", "/../package.json", "/static.zig"]) {
    assert.notEqual((await app.inject({ url })).statusCode, 200, url);
  }
});

test("a file larger than the cork buffer serves intact", async () => {
  const r = await app.inject({ url: "/big.bin" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.rawPayload.length, BIG);
  assert.equal(r.headers["content-length"], String(BIG));
  assert.ok(r.rawPayload.every((b: number) => b === 0x41));
});

test("maxFileBytes excludes oversized files from the mount but keeps small ones", async () => {
  const small = await app.inject({ url: "/capped/assets/style.css" });
  const big = await app.inject({ url: "/capped/big.bin" });
  const overEmpty = await app.inject({ url: "/capped/oversized.bin" });
  assert.equal(small.statusCode, 200);
  assert.equal(small.body, "body{color:red}");
  assert.equal(big.statusCode, 404);
  assert.equal(overEmpty.statusCode, 404);
});

test("HEAD on a large file reports the size without transferring it", async () => {
  const r = await app.inject({ method: "HEAD", url: "/big.bin" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-length"], String(BIG));
  assert.equal(r.rawPayload.length, 0);
});

test("a large file is not corrupted by a 304 round-trip", async () => {
  const first = await app.inject({ url: "/big.bin" });
  const notModified = await app.inject({
    url: "/big.bin",
    headers: { "if-none-match": String(first.headers["etag"]) },
  });
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.rawPayload.length, 0);
  const again = await app.inject({ url: "/big.bin" });
  assert.equal(again.rawPayload.length, BIG);
});
