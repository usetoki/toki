import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "../dist/index.js";
import { delay } from "./helpers.ts";

const order: string[] = [];
const app = createApp();

app.addHook("onRequest", (req) => {
  order.push("onRequest");
  if (req.path === "/guard") {
    return reply.text("blocked", 401);
  }
  if (req.path === "/async-guard") {
    return reply.json({ denied: true }, 401);
  }
});
app.addHook("preParsing", () => {
  order.push("preParsing");
});
app.use((req) => {
  order.push("use");
  if (req.path === "/order") {
    req.setResponseHeader("X-Mw", "1");
  }
});
app.addHook("preValidation", () => {
  order.push("preValidation");
});
app.addHook("preHandler", async (req) => {
  if (req.path === "/amw" || req.path === "/async-order") {
    await delay(10);
  }
  if (req.path === "/throw-hook") {
    throw new Error("hook-fail");
  }
  order.push("preHandler");
});

app.addHook("preSerialization", (_req, payload) => {
  order.push("preSerialization");
  return payload;
});
app.addHook("onResponse", (req, res) => {
  order.push("onResponse");
  if (req.path === "/order" && res.status === 200) {
    return reply.text(`${res.body}!`);
  }
  if (req.path === "/amw") {
    return reply.text(`${res.body}!`);
  }
  if (req.path === "/async-order") {
    return reply.text(`${res.body}/wrapped`);
  }
  if (req.path === "/staged") {
    return reply.text(`${res.body}-rewritten`);
  }
});
app.addHook("onSend", () => {
  order.push("onSend");
});

app.get("/order", () => {
  order.push("handler");
  return reply.text("ok");
});
app.get("/guard", () => reply.text("should not run"));
app.get("/async-guard", () => reply.text("unreached"));
app.get("/amw", () => reply.text("after-async-mw"));
app.get("/async-order", async () => {
  await delay(5);
  order.push("handler");
  return reply.text("core");
});
app.get("/full", () => {
  order.push("handler");
  return { ok: true };
});

app.get("/boom", () => {
  throw new Error("kaboom");
});
app.get("/throw-async", async () => {
  await delay(5);
  throw new Error("async-fail");
});
app.get("/throw-hook", () => reply.text("unreached"));

app.get("/staged", () => reply.text("body"));

app.post("/sink", async (req) => {
  const body = await req.parseBody();
  return reply.json({ received: body, kind: body === undefined ? "empty" : "present" });
});
app.get("/empty204", () => reply.empty(204));

app.get("/ser/obj", () => ({ id: 1 }));
app.get(
  "/ser/scoped",
  { preSerialization: [async (_req, payload) => ({ ...(payload as object), scoped: true })] },
  () => ({ ok: true }),
);
app.get("/ser/text", () => reply.text("raw"));
app.get("/ser/built", () => reply.json({ untouched: true }));

app.onError((req, err) =>
  reply.json({ path: req.path, message: String((err as Error).message) }, 500),
);

app.group("/api/v1", (g) => {
  g.use((req) => {
    order.push("group:use");
    req.setResponseHeader("X-Group", "v1");
  });
  g.get("/ping", () => {
    order.push("handler");
    return reply.text("pong");
  });
  g.get("/users/:id", (req) => reply.json({ id: req.params.id }));
});

app.register(
  (inst) => {
    inst.setErrorHandler(() => {
      throw new Error("handler exploded");
    });
    inst.get("/boom", () => {
      throw new Error("original");
    });
  },
  { prefix: "/faulty" },
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("hooks run in order around the handler", async () => {
  order.length = 0;
  const r = await app.inject("/order");
  assert.deepEqual(order, [
    "onRequest",
    "preParsing",
    "use",
    "preValidation",
    "preHandler",
    "handler",
    "onResponse",
    "onSend",
  ]);
  assert.equal(r.headers["x-mw"], "1");
  assert.equal(r.body, "ok!");
});

test("a hook can short-circuit the handler", async () => {
  const r = await app.inject("/guard");
  assert.equal(r.statusCode, 401);
  assert.equal(r.body, "blocked");
});

test("async middleware keeps the request correct", async () => {
  const r = await app.inject("/amw");
  assert.equal(r.body, "after-async-mw!");
});

test("onError handles a thrown handler", async () => {
  const r = await app.inject("/boom");
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.json(), { path: "/boom", message: "kaboom" });
});

test("groups apply prefix and scoped middleware", async () => {
  const r = await app.inject("/api/v1/ping");
  assert.equal(r.body, "pong");
  assert.equal(r.headers["x-group"], "v1");
});

test("staged response header survives onto the wire", async () => {
  const r = await app.inject("/order");
  assert.equal(r.headers["x-mw"], "1");
});

test("the use() middleware runs in the before-chain between preParsing and preValidation", async () => {
  order.length = 0;
  await app.inject("/full");
  const i = order.indexOf("use");
  assert.ok(i > order.indexOf("preParsing"), "use runs after preParsing");
  assert.ok(i < order.indexOf("preValidation"), "use runs before preValidation");
});

test("an onRequest hook returning a response short-circuits the whole before-chain", async () => {
  order.length = 0;
  const r = await app.inject("/guard");
  assert.equal(r.statusCode, 401);
  assert.deepEqual(order, ["onRequest", "onResponse", "onSend"]);
});

test("all hook phases fire in the documented order", async () => {
  order.length = 0;
  const r = await app.inject("/full");
  assert.deepEqual(r.json(), { ok: true });
  assert.deepEqual(order, [
    "onRequest",
    "preParsing",
    "use",
    "preValidation",
    "preHandler",
    "handler",
    "preSerialization",
    "onResponse",
    "onSend",
  ]);
});

test("async hooks preserve ordering across awaits", async () => {
  order.length = 0;
  const r = await app.inject("/async-order");
  assert.equal(r.body, "core/wrapped");
  const handlerAt = order.indexOf("handler");
  assert.ok(order.indexOf("preHandler") < handlerAt, "preHandler before handler");
  assert.ok(order.indexOf("onResponse") > handlerAt, "onResponse after handler");
});

test("an async before-hook short-circuit skips the handler", async () => {
  order.length = 0;
  const r = await app.inject("/async-guard");
  assert.equal(r.statusCode, 401);
  assert.deepEqual(r.json(), { denied: true });
  assert.ok(!order.includes("handler"), "handler must not run after short-circuit");
  assert.ok(!order.includes("preHandler"), "preHandler must not run after short-circuit");
});

test("onError catches a rejected async handler with the real error", async () => {
  const r = await app.inject("/throw-async");
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.json(), { path: "/throw-async", message: "async-fail" });
});

test("onError catches a throw from inside a before-hook", async () => {
  const r = await app.inject("/throw-hook");
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.json(), { path: "/throw-hook", message: "hook-fail" });
});

test("a scoped error handler that throws falls back to the default 500", async () => {
  const r = await app.inject("/faulty/boom");
  assert.equal(r.statusCode, 500);
  assert.equal(r.body, "Internal Server Error");
});

test("group params resolve under the prefix", async () => {
  const r = await app.inject("/api/v1/users/7");
  assert.deepEqual(r.json(), { id: "7" });
});

test("a route outside the group does not get group middleware", async () => {
  const r = await app.inject("/order");
  assert.equal(r.headers["x-group"], undefined);
});

test("an unknown path under a group prefix is a 404", async () => {
  const r = await app.inject("/api/v1/missing");
  assert.equal(r.statusCode, 404);
});

test("setResponseHeader/appendResponseHeader stage onto a rewritten response", async () => {
  const r = await app.inject("/staged");
  assert.equal(r.body, "body-rewritten");
});

test("preSerialization is recorded for a plain object payload", async () => {
  order.length = 0;
  const r = await app.inject("/ser/obj");
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(r.json(), { id: 1 });
  assert.ok(order.includes("preSerialization"), "object payload runs preSerialization");
});

test("global then route-scoped preSerialization compose in order", async () => {
  const r = await app.inject("/ser/scoped");
  assert.deepEqual(r.json(), { ok: true, scoped: true });
});

test("string and built-reply results bypass preSerialization", async () => {
  order.length = 0;
  assert.equal((await app.inject("/ser/text")).body, "raw");
  assert.deepEqual((await app.inject("/ser/built")).json(), { untouched: true });
  assert.ok(!order.includes("preSerialization"), "strings/built replies skip preSerialization");
});

test("a recording hook returning nothing does not short-circuit a 204", async () => {
  const r = await app.inject("/empty204");
  assert.equal(r.statusCode, 204);
  assert.equal(r.body, "");
});

test("an empty POST body parses to undefined, not a 500", async () => {
  const r = await app.inject({ method: "POST", url: "/sink" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { kind: "empty" });
});

test("a POST with a JSON body parses to the object", async () => {
  const r = await app.inject({ method: "POST", url: "/sink", payload: { a: 1 } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { received: { a: 1 }, kind: "present" });
});

test("an unknown method/path returns the default 404", async () => {
  const r = await app.inject({ method: "DELETE", url: "/totally/unknown" });
  assert.equal(r.statusCode, 404);
});
