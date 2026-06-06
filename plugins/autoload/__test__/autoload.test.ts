import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "@usetoki/toki";
import { autoload, joinPrefix, routePrefix } from "../dist/index.js";

test("routePrefix derives URL prefixes from file paths", () => {
  assert.equal(routePrefix("index.ts"), "/");
  assert.equal(routePrefix("health.ts"), "/health");
  assert.equal(routePrefix("users/index.ts"), "/users");
  assert.equal(routePrefix("users/[id].ts"), "/users/:id");
  assert.equal(routePrefix("files/[...path].ts"), "/files/*");
});

test("joinPrefix collapses slashes", () => {
  assert.equal(joinPrefix("/", "/"), "/");
  assert.equal(joinPrefix("/api", "/users"), "/api/users");
  assert.equal(joinPrefix("/", "/users/:id"), "/users/:id");
});

const dir = mkdtempSync(join(tmpdir(), "toki-autoload-"));
mkdirSync(join(dir, "users"));
writeFileSync(join(dir, "index.mjs"), `export const get = () => "root";`);
writeFileSync(join(dir, "health.mjs"), `export const get = () => "ok";`);
writeFileSync(join(dir, "users", "index.mjs"), `export const get = () => "list";`);
writeFileSync(
  join(dir, "users", "[id].mjs"),
  `export const get = (req) => req.params.id ?? "none";`,
);
writeFileSync(join(dir, "_hidden.mjs"), `export const get = () => "hidden";`);
// a default-exported plugin still works (for routes that want their own hooks)
writeFileSync(
  join(dir, "widgets.mjs"),
  `export default (app) => { app.get("/list", () => "wl"); };`,
);

const app = createApp({ logger: false });
let handle: ReturnType<typeof app.listen>;
before(async () => {
  await autoload(app, { dir, prefix: "/api" });
  handle = app.listen(0, { host: "127.0.0.1" });
});
after(() => {
  handle?.close();
  rmSync(dir, { recursive: true, force: true });
});

const text = async (url: string) => (await app.inject({ url })).body;

test("method exports register at clean paths under the base prefix", async () => {
  assert.equal(await text("/api"), "root");
  assert.equal(await text("/api/health"), "ok");
  assert.equal(await text("/api/users"), "list");
});

test("bracket segments become route params", async () => {
  assert.equal(await text("/api/users/42"), "42");
});

test("a default-exported plugin is registered under its prefix", async () => {
  assert.equal(await text("/api/widgets/list"), "wl");
});

test("partials and dotfiles are skipped", async () => {
  assert.equal((await app.inject({ url: "/api/hidden" })).statusCode, 404);
});

test("a module that exports nothing usable is rejected", async () => {
  const bad = mkdtempSync(join(tmpdir(), "toki-autoload-bad-"));
  writeFileSync(join(bad, "broken.mjs"), `export const handler = () => "x";`);
  const app2 = createApp({ logger: false });
  await assert.rejects(
    () => autoload(app2, { dir: bad }),
    /neither a default plugin nor a method handler/,
  );
  rmSync(bad, { recursive: true, force: true });
});
