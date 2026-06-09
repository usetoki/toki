import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createApp } from "@usetoki/toki";
import { parseRange, sendRange } from "../src/index.ts";

test("parseRange handles every single-range form", () => {
  assert.deepEqual(parseRange("bytes=0-3", 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange("bytes=-4", 10), { start: 6, end: 9 });
  assert.deepEqual(parseRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange("bytes=8-100", 10), { start: 8, end: 9 }); // clamped to the end
  assert.equal(parseRange("bytes=20-30", 10), "invalid");
  assert.equal(parseRange("bytes=-0", 10), "invalid");
  assert.equal(parseRange("bytes=0-3", 0), "invalid");
  assert.equal(parseRange("bytes=0-1,3-4", 10), null); // multi-range → serve full
  assert.equal(parseRange("nonsense", 10), null);
});

const dir = mkdtempSync(join(tmpdir(), "toki-range-"));
writeFileSync(join(dir, "f.txt"), "abcdefghij");
const filePath = join(dir, "f.txt");

const app = createApp({ logger: false });
app.get("/buf", (req) => sendRange(req, Buffer.from("0123456789"), { contentType: "text/plain" }));
app.get("/file", (req) => sendRange(req, filePath, { contentType: "text/plain" }));
const handle = app.listen(0, { host: "127.0.0.1" });
after(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a request without Range gets the whole entity and Accept-Ranges", async () => {
  const res = await app.inject({ url: "/buf" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "0123456789");
  assert.equal(res.headers["accept-ranges"], "bytes");
});

test("a satisfiable range gets 206 with Content-Range", async () => {
  const res = await app.inject({ url: "/buf", headers: { range: "bytes=0-3" } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.body, "0123");
  assert.equal(res.headers["content-range"], "bytes 0-3/10");
});

test("a suffix range returns the last bytes", async () => {
  const res = await app.inject({ url: "/buf", headers: { range: "bytes=-2" } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.body, "89");
  assert.equal(res.headers["content-range"], "bytes 8-9/10");
});

test("an unsatisfiable range gets 416", async () => {
  const res = await app.inject({ url: "/buf", headers: { range: "bytes=20-30" } });
  assert.equal(res.statusCode, 416);
  assert.equal(res.headers["content-range"], "bytes */10");
});

test("a multi-range request falls back to the full entity", async () => {
  const res = await app.inject({ url: "/buf", headers: { range: "bytes=0-1,3-4" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "0123456789");
});

test("a file range is streamed as 206", async () => {
  const partial = await app.inject({ url: "/file", headers: { range: "bytes=2-5" } });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.body, "cdef");
  assert.equal(partial.headers["content-range"], "bytes 2-5/10");
  assert.equal(partial.headers["content-length"], "4"); // a range read carries a real length

  const full = await app.inject({ url: "/file" });
  assert.equal(full.statusCode, 200);
  assert.equal(full.body, "abcdefghij");
});
