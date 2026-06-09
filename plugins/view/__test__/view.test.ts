import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createView, type ViewEngine } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "toki-view-"));
writeFileSync(join(dir, "hello.html"), "Hi {{name}}!");
writeFileSync(join(dir, "page.html"), "{{title}} — {{site}}");
writeFileSync(join(dir, "cached.html"), "v1");
after(() => rmSync(dir, { recursive: true, force: true }));

// a trivial {{key}} interpolation engine
const mustache: ViewEngine = {
  compile: (source) => (data) => source.replace(/\{\{(\w+)\}\}/g, (_, k) => String(data[k] ?? "")),
};

const decode = (body: string | Uint8Array): string =>
  typeof body === "string" ? body : Buffer.from(body).toString("utf8");

test("renders a template with data as HTML", async () => {
  const view = createView({ engine: mustache, root: dir, ext: ".html" });
  const res = await view("hello", { name: "Ada" });
  assert.equal(decode(res.body), "Hi Ada!");
  assert.equal(res.contentType, "text/html; charset=utf-8");
});

test("merges locals, with per-render data taking precedence", async () => {
  const view = createView({ engine: mustache, root: dir, ext: ".html", locals: { site: "Toki" } });
  assert.equal(decode((await view("page", { title: "Home" })).body), "Home — Toki");
  assert.equal(decode((await view("page", { title: "X", site: "Override" })).body), "X — Override");
});

test("caches compiled templates by default, recompiles when caching is off", async () => {
  const cached = createView({ engine: mustache, root: dir, ext: ".html" });
  const live = createView({ engine: mustache, root: dir, ext: ".html", cache: false });
  assert.equal(decode((await cached("cached")).body), "v1");
  assert.equal(decode((await live("cached")).body), "v1");

  writeFileSync(join(dir, "cached.html"), "v2");
  assert.equal(decode((await cached("cached")).body), "v1"); // served from cache
  assert.equal(decode((await live("cached")).body), "v2"); // re-read from disk
});

test("a missing template rejects", async () => {
  const view = createView({ engine: mustache, root: dir, ext: ".html" });
  await assert.rejects(() => view("does-not-exist"));
});

test("a template name cannot escape the root", async () => {
  const view = createView({ engine: mustache, root: dir, ext: ".html" });
  await assert.rejects(() => view("../../../../etc/passwd"), /escapes the root/);
});

test("an async engine is awaited", async () => {
  const asyncEngine: ViewEngine = {
    compile: (source) => async (data) => {
      await Promise.resolve();
      return source.replace("{{name}}", String(data.name));
    },
  };
  const view = createView({ engine: asyncEngine, root: dir, ext: ".html" });
  assert.equal(decode((await view("hello", { name: "Lin" })).body), "Hi Lin!");
});
