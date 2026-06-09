import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createApp, reply } from "../ts/index.ts";

// app.cors() registers an OPTIONS /* wildcard. Regression: that wildcard must not turn a
// GET miss into a 405, nor shadow the static-file / not-found fallback — while real
// preflight and genuine method-mismatch 405s keep working.
const dir = mkdtempSync(join(tmpdir(), "toki-cors-static-"));
writeFileSync(join(dir, "info.txt"), "static body");

const app = createApp({ logger: false });
app.cors();
app.static("/pub", dir);
app.get("/only-get", () => reply.text("g"));
app.setNotFoundHandler((req) => reply.json({ missing: req.path }, 404));

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a wildcard OPTIONS route does not turn a GET miss into 405", async () => {
  const res = await app.inject({ url: "/does-not-exist" });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { missing: string }).missing, "/does-not-exist");
});

test("static files are still served alongside the cors wildcard", async () => {
  const res = await app.inject({ url: "/pub/info.txt" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "static body");
});

test("cors preflight still resolves to the wildcard", async () => {
  const res = await app.inject({ method: "OPTIONS", url: "/only-get" });
  assert.ok(res.statusCode < 400, `preflight status ${res.statusCode}`);
  assert.ok(res.headers["access-control-allow-origin"]);
});

test("a genuine method mismatch is still 405", async () => {
  const res = await app.inject({ method: "POST", url: "/only-get" });
  assert.equal(res.statusCode, 405);
});
