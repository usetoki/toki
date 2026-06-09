import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, reply } from "../ts/index.ts";

// one app per file: a second createApp().inject() in the same process aborts the native engine (exit 144)
const app = createApp({ logger: false });

app.get("/users/:id", (req) => reply.json({ id: req.params.id }));
app.get("/u/:uid/posts/:pid", (req) => reply.json({ ...req.params }));
app.get("/multi/:a/:b/:c", (req) => reply.json({ ...req.params }));
app.get("/static/*", (req) => reply.text(req.params["*"] ?? ""));
app.get("/users", () => reply.text("list"));
app.post("/users/:id", (req) => reply.json({ updated: req.params.id }));
app.get("/edge/:id/end", (req) => reply.json({ id: req.params.id }));
app.get("/q/:id", (req) => reply.json({ id: req.params.id, x: req.query.get("x") }));
app.head("/probe/:id", () => reply.empty(204));

app.get("/noarg/:id", () => reply.text("ok"));
app.get("/over/:id", (req, res?: undefined, next?: undefined) =>
  reply.json({ id: req.params.id, res: res === undefined, next: next === undefined }),
);

app.get("/p/new", () => reply.text("static"));
app.get("/p/:id", (req) => reply.json({ id: req.params.id }));
app.get("/x/:id", (req) => reply.json({ id: req.params.id }));
app.get("/x/:id/edit", (req) => reply.json({ edit: req.params.id }));

app.get("/frozen/:id", (req) => {
  assert.equal(Object.isFrozen(req.params), true);
  return reply.text("ok");
});

test("single param", async () => {
  const r = await app.inject({ url: "/users/42" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { id: "42" });
});

test("multiple params", async () => {
  const r = await app.inject({ url: "/u/7/posts/99" });
  assert.deepEqual(r.json(), { uid: "7", pid: "99" });
});

test("three adjacent params keep order and value", async () => {
  const r = await app.inject({ url: "/multi/1/2/3" });
  assert.deepEqual(r.json(), { a: "1", b: "2", c: "3" });
});

test("wildcard captures the rest of the path", async () => {
  const r = await app.inject({ url: "/static/css/app.css" });
  assert.equal(r.body, "css/app.css");
});

test("exact route still wins over a dynamic sibling", async () => {
  const r = await app.inject({ url: "/users" });
  assert.equal(r.body, "list");
});

test("same path, different method routes correctly", async () => {
  const r = await app.inject({ method: "POST", url: "/users/5" });
  assert.deepEqual(r.json(), { updated: "5" });
});

test("unmatched dynamic depth is 404", async () => {
  const r = await app.inject({ url: "/users/1/extra" });
  assert.equal(r.statusCode, 404);
});

test("405 lists the allowed methods for a dynamic path", async () => {
  const r = await app.inject({ method: "DELETE", url: "/users/5" });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers.allow, "GET, POST");
});

test("OPTIONS on a dynamic path is 405 with Allow when not registered", async () => {
  const r = await app.inject({ method: "OPTIONS", url: "/users/5" });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers.allow, "GET, POST");
});

test("percent-decoded param (encoded slash)", async () => {
  const r = await app.inject({ url: "/users/a%2Fb" });
  assert.deepEqual(r.json(), { id: "a/b" });
});

test("percent-decoded param (UTF-8 multibyte)", async () => {
  const r = await app.inject({ url: "/users/caf%C3%A9" });
  assert.deepEqual(r.json(), { id: "café" });
});

test("percent-decoded param (space via %20)", async () => {
  const r = await app.inject({ url: "/users/a%20b" });
  assert.deepEqual(r.json(), { id: "a b" });
});

test("plus is a literal in path params, not a space", async () => {
  const r = await app.inject({ url: "/users/a+b" });
  assert.deepEqual(r.json(), { id: "a+b" });
});

test("dangling percent is left verbatim, not an error", async () => {
  const r = await app.inject({ url: "/users/100%" });
  assert.deepEqual(r.json(), { id: "100%" });
});

test("invalid percent escape is left verbatim", async () => {
  const r = await app.inject({ url: "/users/%zz" });
  assert.deepEqual(r.json(), { id: "%zz" });
});

test("wildcard tail is percent-decoded too", async () => {
  const r = await app.inject({ url: "/static/a%2Fb/c%20d" });
  assert.equal(r.body, "a/b/c d");
});

test("empty segment yields an empty-string param", async () => {
  const r = await app.inject({ url: "/edge//end" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { id: "" });
});

test("absent param key reads as undefined", async () => {
  const r = await app.inject({ url: "/users/7" });
  const body = r.json() as Record<string, unknown>;
  assert.equal(body.nope, undefined);
  assert.deepEqual(Object.keys(body), ["id"]);
});

test("params object is frozen", async () => {
  const r = await app.inject({ url: "/frozen/1" });
  assert.equal(r.body, "ok");
});

test("a colon inside a value is a plain character", async () => {
  const r = await app.inject({ url: "/users/a:b:c" });
  assert.deepEqual(r.json(), { id: "a:b:c" });
});

test("dot inside a param value is captured whole", async () => {
  const r = await app.inject({ url: "/users/photo.png" });
  assert.deepEqual(r.json(), { id: "photo.png" });
});

test("query string coexists with a param and is not part of it", async () => {
  const r = await app.inject({ url: "/q/v?x=1&y=2" });
  assert.deepEqual(r.json(), { id: "v", x: "1" });
});

test("wildcard matches an empty tail (trailing slash)", async () => {
  const r = await app.inject({ url: "/static/" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "");
});

test("wildcard prefix with no trailing slash matches an empty tail (no OOB)", async () => {
  const r = await app.inject({ url: "/static" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "");
});

test("wildcard captures deeply nested tails", async () => {
  const r = await app.inject({ url: "/static/a/b/c/d/e.txt" });
  assert.equal(r.body, "a/b/c/d/e.txt");
});

test("HEAD on a HEAD route returns its status with no body", async () => {
  const r = await app.inject({ method: "HEAD", url: "/probe/9" });
  assert.equal(r.statusCode, 204);
  assert.equal(r.body, "");
});

test("handler that ignores req still serves the route", async () => {
  const r = await app.inject({ url: "/noarg/9" });
  assert.equal(r.body, "ok");
});

test("over-declared handler args are undefined, not a crash", async () => {
  const r = await app.inject({ url: "/over/3" });
  assert.deepEqual(r.json(), { id: "3", res: true, next: true });
});

test("static literal segment beats a param at the same depth", async () => {
  const a = await app.inject({ url: "/p/new" });
  const b = await app.inject({ url: "/p/123" });
  assert.equal(a.body, "static");
  assert.deepEqual(b.json(), { id: "123" });
});

test("param route does not swallow a deeper static route", async () => {
  const a = await app.inject({ url: "/x/5" });
  const b = await app.inject({ url: "/x/5/edit" });
  assert.deepEqual(a.json(), { id: "5" });
  assert.deepEqual(b.json(), { edit: "5" });
});
