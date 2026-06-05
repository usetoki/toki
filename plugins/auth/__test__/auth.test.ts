import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply, type TokiRequest } from "@usetoki/toki";
import { apiKey, auth, basic, bearer, safeEqual } from "../dist/index.js";

const app = createApp({ logger: false });

const checkBasic = basic((user, pass) =>
  user === "admin" && safeEqual(pass, "s3cret") ? { name: "admin" } : null,
);
const checkBearer = bearer((token) => (token === "good-token" ? { id: 1 } : null));
const checkKey = apiKey((key) => (key === "key-123" ? { svc: "billing" } : null), {
  query: "api_key",
});

const who = (req: TokiRequest) => reply.json(req.user ?? null);

app.get("/basic", { preHandler: auth(checkBasic) }, who);
app.get("/bearer", { preHandler: auth(checkBearer) }, who);
app.get("/apikey", { preHandler: auth(checkKey) }, who);
app.get("/any", { preHandler: auth([checkBearer, checkKey]) }, who);
app.get("/all", { preHandler: auth([checkBearer, checkKey], { mode: "allOf" }) }, who);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

const basicHeader = (u: string, p: string): string =>
  `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

test("basic auth accepts valid credentials and sets req.user", async () => {
  const r = await app.inject({
    url: "/basic",
    headers: { authorization: basicHeader("admin", "s3cret") },
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { name: "admin" });
});

test("basic auth rejects bad credentials with 401 + WWW-Authenticate", async () => {
  const r = await app.inject({
    url: "/basic",
    headers: { authorization: basicHeader("admin", "wrong") },
  });
  assert.equal(r.statusCode, 401);
  assert.match(String(r.headers["www-authenticate"]), /^Basic realm=/);
});

test("a missing Authorization header is a 401", async () => {
  const r = await app.inject({ url: "/basic" });
  assert.equal(r.statusCode, 401);
});

test("bearer auth accepts a known token", async () => {
  const ok = await app.inject({ url: "/bearer", headers: { authorization: "Bearer good-token" } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { id: 1 });
  const bad = await app.inject({ url: "/bearer", headers: { authorization: "Bearer nope" } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers["www-authenticate"], "Bearer");
});

test("api-key auth reads the header and the query fallback", async () => {
  const viaHeader = await app.inject({ url: "/apikey", headers: { "x-api-key": "key-123" } });
  assert.equal(viaHeader.statusCode, 200);
  assert.deepEqual(viaHeader.json(), { svc: "billing" });
  const viaQuery = await app.inject({ url: "/apikey?api_key=key-123" });
  assert.equal(viaQuery.statusCode, 200);
  const missing = await app.inject({ url: "/apikey" });
  assert.equal(missing.statusCode, 401);
});

test("anyOf passes when any strategy succeeds", async () => {
  const viaBearer = await app.inject({
    url: "/any",
    headers: { authorization: "Bearer good-token" },
  });
  assert.equal(viaBearer.statusCode, 200);
  const viaKey = await app.inject({ url: "/any", headers: { "x-api-key": "key-123" } });
  assert.equal(viaKey.statusCode, 200);
  const none = await app.inject({ url: "/any" });
  assert.equal(none.statusCode, 401);
});

test("allOf requires every strategy to succeed", async () => {
  const both = await app.inject({
    url: "/all",
    headers: { authorization: "Bearer good-token", "x-api-key": "key-123" },
  });
  assert.equal(both.statusCode, 200);
  assert.deepEqual(both.json(), { svc: "billing" }); // last strategy's user

  const onlyBearer = await app.inject({
    url: "/all",
    headers: { authorization: "Bearer good-token" },
  });
  assert.equal(onlyBearer.statusCode, 401);
});

test("safeEqual is correct", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});
