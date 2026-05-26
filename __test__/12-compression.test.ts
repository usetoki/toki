import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { reply } from "../ts";
import { rawRequest, withServer, type RunningServer } from "./helpers";

/** Split a raw HTTP response into its head string and body buffer. */
function splitResponse(raw: Buffer): { head: string; body: Buffer } {
  const marker = Buffer.from("\r\n\r\n");
  const idx = raw.indexOf(marker);
  return { head: raw.subarray(0, idx).toString("latin1"), body: raw.subarray(idx + marker.length) };
}

function headerFromRaw(head: string, name: string): string | null {
  const line = head.split("\r\n").find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

describe("compression", () => {
  let server: RunningServer;
  // A body large enough to clear compressionMinSize and worth encoding.
  const bigPayload = {
    items: Array.from({ length: 400 }, (_, i) => ({
      id: i,
      text: "the quick brown fox jumps over the lazy dog ".repeat(3),
    })),
  };
  const bigJson = JSON.stringify(bigPayload);

  before(async () => {
    server = await withServer(
      (app) => {
        app.get("/big", () => reply.json(bigPayload));
        app.get("/small", () => reply.json({ ok: true }));
        app.native.json("/manifest", bigPayload);
      },
      { compression: true, compressionMinSize: 1024 },
    );
  });

  after(() => server.close());

  test("Accept-Encoding: br yields a brotli body with Vary that decompresses to the original", async () => {
    const raw = await rawRequest(
      server.port,
      "GET /big HTTP/1.1\r\nHost: x\r\nAccept-Encoding: br\r\nConnection: close\r\n\r\n",
    );
    const { head, body } = splitResponse(raw);
    assert.equal(headerFromRaw(head, "content-encoding"), "br");
    assert.equal(headerFromRaw(head, "vary"), "Accept-Encoding");
    assert.equal(brotliDecompressSync(body).toString("utf8"), bigJson);
  });

  test("Accept-Encoding: gzip yields a gzip body that decompresses to the original", async () => {
    const raw = await rawRequest(
      server.port,
      "GET /big HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n",
    );
    const { head, body } = splitResponse(raw);
    assert.equal(headerFromRaw(head, "content-encoding"), "gzip");
    assert.equal(gunzipSync(body).toString("utf8"), bigJson);
  });

  test("no Accept-Encoding sends identity (uncompressed)", async () => {
    const raw = await rawRequest(
      server.port,
      "GET /big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    const { head, body } = splitResponse(raw);
    assert.equal(headerFromRaw(head, "content-encoding"), null);
    assert.equal(body.toString("utf8"), bigJson);
  });

  test("a body below compressionMinSize is not compressed even when br is offered", async () => {
    const raw = await rawRequest(
      server.port,
      "GET /small HTTP/1.1\r\nHost: x\r\nAccept-Encoding: br\r\nConnection: close\r\n\r\n",
    );
    const { head, body } = splitResponse(raw);
    assert.equal(headerFromRaw(head, "content-encoding"), null);
    assert.deepEqual(JSON.parse(body.toString("utf8")), { ok: true });
  });

  test("a native route serves its pre-compressed brotli variant", async () => {
    const raw = await rawRequest(
      server.port,
      "GET /manifest HTTP/1.1\r\nHost: x\r\nAccept-Encoding: br\r\nConnection: close\r\n\r\n",
    );
    const { head, body } = splitResponse(raw);
    assert.equal(headerFromRaw(head, "content-encoding"), "br");
    assert.equal(headerFromRaw(head, "vary"), "Accept-Encoding");
    assert.equal(brotliDecompressSync(body).toString("utf8"), bigJson);
  });

  test("fetch transparently decodes the compressed body", async () => {
    // undici auto-decompresses; the content-encoding header is still visible.
    const res = await fetch(`${server.base}/big`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(res.headers.get("content-encoding"), "gzip");
    assert.equal(await res.text(), bigJson);
  });
});
