import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { etag } from "../dist/index.js";

const app = createApp({ logger: false });

// strong (default) on one scope, weak + sha1 on their own scopes
app.register(
  (s) => {
    etag(s);
    s.get("/hello", () => reply.text("hello"));
    s.get("/world", () => reply.text("world"));
    s.get("/json", () => reply.json({ a: 1 }));
    s.post("/hello", () => reply.text("hello"));
    s.get("/err", () => reply.text("boom", 500));
    s.get("/owntag", (req) => {
      req.setResponseHeader("ETag", '"mine"');
      return reply.text("x");
    });
  },
  { prefix: "/s" },
);
app.register(
  (s) => {
    etag(s, { weak: true });
    s.get("/hello", () => reply.text("hello"));
  },
  { prefix: "/weak" },
);
app.register(
  (s) => {
    etag(s, { algorithm: "sha1" });
    s.get("/hello", () => reply.text("hello"));
  },
  { prefix: "/sha" },
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

type Res = Awaited<ReturnType<typeof app.inject>>;
const tag = (res: Res): string | undefined => res.headers["etag"] as string | undefined;

test("a GET response carries a strong, quoted ETag", async () => {
  const res = await app.inject({ url: "/s/hello" });
  assert.equal(res.statusCode, 200);
  assert.match(tag(res) ?? "", /^"[^"]+"$/);
});

test("the same body yields the same ETag, different bodies differ", async () => {
  const a = tag(await app.inject({ url: "/s/hello" }));
  const b = tag(await app.inject({ url: "/s/hello" }));
  const c = tag(await app.inject({ url: "/s/world" }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("a matching If-None-Match returns 304 with an empty body and the ETag", async () => {
  const first = await app.inject({ url: "/s/hello" });
  const conditional = await app.inject({
    url: "/s/hello",
    headers: { "if-none-match": tag(first)! },
  });
  assert.equal(conditional.statusCode, 304);
  assert.equal(conditional.body, "");
  assert.equal(tag(conditional), tag(first));
});

test("If-None-Match: * always validates to 304", async () => {
  const res = await app.inject({ url: "/s/hello", headers: { "if-none-match": "*" } });
  assert.equal(res.statusCode, 304);
});

test("a non-matching If-None-Match returns 200 with the body and a fresh ETag", async () => {
  const res = await app.inject({ url: "/s/hello", headers: { "if-none-match": '"stale"' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "hello");
  assert.ok(tag(res));
});

test("non-GET/HEAD responses are not tagged", async () => {
  const res = await app.inject({ method: "POST", url: "/s/hello" });
  assert.equal(tag(res), undefined);
});

test("HEAD requests are tagged and honor If-None-Match", async () => {
  const head = await app.inject({ method: "HEAD", url: "/s/hello" });
  assert.ok(tag(head));
  const conditional = await app.inject({
    method: "HEAD",
    url: "/s/hello",
    headers: { "if-none-match": tag(head)! },
  });
  assert.equal(conditional.statusCode, 304);
});

test("weak mode emits a W/ validator that still matches", async () => {
  const res = await app.inject({ url: "/weak/hello" });
  assert.match(tag(res) ?? "", /^W\/"/);
  const conditional = await app.inject({
    url: "/weak/hello",
    headers: { "if-none-match": tag(res)! },
  });
  assert.equal(conditional.statusCode, 304);
});

test("the sha1 algorithm produces a different validator than fnv1a", async () => {
  const sha = tag(await app.inject({ url: "/sha/hello" }));
  const fnv = tag(await app.inject({ url: "/s/hello" }));
  assert.ok(sha && fnv && sha !== fnv);
  // crypto digests round-trip a 304 just the same
  const conditional = await app.inject({ url: "/sha/hello", headers: { "if-none-match": sha! } });
  assert.equal(conditional.statusCode, 304);
});

test("error responses are never turned into a 304", async () => {
  const res = await app.inject({ url: "/s/err", headers: { "if-none-match": "*" } });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, "boom");
  assert.equal(tag(res), undefined);
});

test("an ETag the handler set itself is preserved", async () => {
  const res = await app.inject({ url: "/s/owntag" });
  assert.equal(tag(res), '"mine"');
});
