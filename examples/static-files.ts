// run: node examples/static-files.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "toki-static-"));
writeFileSync(join(dir, "hello.txt"), "hello from disk\n");

const app = createApp({ logger: false });
app.static("/assets", dir);

const first = await app.inject("/assets/hello.txt");
assert.equal(first.statusCode, 200);
assert.equal(first.body, "hello from disk\n");

const etag = first.headers.etag as string;
assert.ok(etag, "expected an ETag header");

const cached = await app.inject({
  url: "/assets/hello.txt",
  headers: { "If-None-Match": etag },
});
assert.equal(cached.statusCode, 304);
assert.equal(cached.body, "");

console.log("static-files: ok (200 served, ETag honored, 304 on revalidate)");
process.exit(0);
