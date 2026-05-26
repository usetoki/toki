import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  makeTempDir,
  removeTempDir,
  withServer,
  writeFixture,
  type RunningServer,
} from "./helpers";

describe("static file serving", () => {
  let server: RunningServer;
  let dir: string;

  before(async () => {
    dir = makeTempDir("static");
    writeFixture(dir, "data.json", JSON.stringify({ hello: "world" }));
    writeFixture(dir, "page.html", "<h1>page</h1>");
    writeFixture(dir, "bytes.bin", "0123456789");
    writeFixture(dir, "index.html", "<h1>index</h1>");
    server = await withServer((app) => {
      app.static("/static", dir, { cacheControl: "public, max-age=3600", indexFile: "index.html" });
    });
  });

  after(() => {
    server.close();
    removeTempDir(dir);
  });

  test("serves a JSON file with the right content-type and ETag", async () => {
    const res = await fetch(`${server.base}/static/data.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.match(res.headers.get("etag") ?? "", /^"[0-9a-f]+-[0-9a-f]+"$/);
    assert.deepEqual(await res.json(), { hello: "world" });
  });

  test("guesses content-type from the extension", async () => {
    const res = await fetch(`${server.base}/static/page.html`);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await res.text(), "<h1>page</h1>");
  });

  test("a matching If-None-Match yields 304 with no body", async () => {
    const first = await fetch(`${server.base}/static/data.json`);
    const etag = first.headers.get("etag")!;
    await first.body?.cancel();

    const res = await fetch(`${server.base}/static/data.json`, {
      headers: { "if-none-match": etag },
    });
    assert.equal(res.status, 304);
    assert.equal(res.headers.get("etag"), etag);
    assert.equal(await res.text(), "");
  });

  test("a satisfiable Range yields 206 with Content-Range and the partial body", async () => {
    const res = await fetch(`${server.base}/static/bytes.bin`, {
      headers: { range: "bytes=2-5" },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(res.headers.get("content-length"), "4");
    assert.equal(await res.text(), "2345");
  });

  test("an unsatisfiable Range yields 416 with a Content-Range of the full length", async () => {
    const res = await fetch(`${server.base}/static/bytes.bin`, {
      headers: { range: "bytes=100-200" },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), "bytes */10");
    await res.body?.cancel();
  });

  test("a missing file yields 404", async () => {
    const res = await fetch(`${server.base}/static/nope.txt`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not Found");
  });

  test("a raw directory traversal is blocked", async () => {
    const res = await fetch(`${server.base}/static/../../../etc/passwd`, { redirect: "manual" });
    // The client may normalize ".." before sending; either way the server must not
    // serve a file outside the mount (404 from the server, or a redirect from undici).
    assert.notEqual(res.status, 200);
    await res.body?.cancel();
  });

  test("a percent-encoded directory traversal is blocked", async () => {
    // %2e%2e and %2f are decoded per-segment and rejected, never forming a new component.
    const res = await fetch(`${server.base}/static/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.equal(res.status, 404);
    await res.body?.cancel();
  });

  test("HEAD returns headers only with the file's Content-Length", async () => {
    const res = await fetch(`${server.base}/static/bytes.bin`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "10");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(await res.text(), "");
  });

  test("the index file is served for the mount root", async () => {
    const res = await fetch(`${server.base}/static`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await res.text(), "<h1>index</h1>");
  });

  test("a non-GET/HEAD method on a static mount is a native 405 with Allow", async () => {
    const res = await fetch(`${server.base}/static/data.json`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
    await res.body?.cancel();
  });
});
