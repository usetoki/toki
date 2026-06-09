import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, reply } from "../ts/index.ts";
import { delay } from "./helpers.ts";

{
  const order: string[] = [];
  const timedOut: string[] = [];

  const app = createApp({ requestTimeoutMs: 80 });

  app.addHook("onRequest", () => {
    order.push("onRequest");
  });
  app.addHook("preParsing", () => {
    order.push("preParsing");
  });
  app.addHook("preValidation", () => {
    order.push("preValidation");
  });
  app.addHook("preHandler", () => {
    order.push("preHandler");
  });
  app.addHook("onTimeout", (req) => {
    timedOut.push(req.path);
  });

  app.get("/ordered", () => {
    order.push("handler");
    return reply.text("ok");
  });

  app.get("/slow", async () => {
    await delay(300);
    return reply.text("late");
  });

  app.get("/fast", async () => {
    await delay(5);
    return reply.text("quick");
  });

  test("pre-handler hooks fire onRequest → preParsing → preValidation → preHandler → handler", async () => {
    order.length = 0;
    await app.inject("/ordered");
    assert.deepEqual(order, ["onRequest", "preParsing", "preValidation", "preHandler", "handler"]);
  });

  test("a request over requestTimeoutMs gets 408 and fires onTimeout", async () => {
    timedOut.length = 0;
    const res = await app.inject("/slow");
    assert.equal(res.statusCode, 408);
    assert.equal(res.body, "Request Timeout");
    assert.deepEqual(timedOut, ["/slow"]);
  });

  test("a fast async handler completes normally (no spurious timeout)", async () => {
    timedOut.length = 0;
    const res = await app.inject("/fast");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "quick");
    assert.deepEqual(timedOut, []);
  });
}

{
  const order: string[] = [];
  const app = createApp();

  app.addHook("onRequest", () => {
    order.push("onRequest");
  });
  app.addHook("preParsing", () => {
    order.push("preParsing");
  });
  app.addHook("preValidation", () => {
    order.push("preValidation");
  });
  app.addHook("preHandler", () => {
    order.push("preHandler");
  });
  app.addHook("preSerialization", (_req, payload) => {
    order.push("preSerialization");
    return payload;
  });
  app.addHook("onResponse", () => {
    order.push("onResponse");
  });
  app.addHook("onSend", () => {
    order.push("onSend");
  });

  app.get("/full", () => {
    order.push("handler");
    return { ok: true };
  });

  test("the whole hook chain fires in lifecycle order around the handler", async () => {
    order.length = 0;
    const res = await app.inject("/full");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.deepEqual(order, [
      "onRequest",
      "preParsing",
      "preValidation",
      "preHandler",
      "handler",
      "preSerialization",
      "onResponse",
      "onSend",
    ]);
  });

  test("preSerialization only runs for plain values, not for built replies", async () => {
    const built = createApp();
    const seen: string[] = [];
    built.addHook("preSerialization", (_req, payload) => {
      seen.push("preSerialization");
      return payload;
    });
    built.get("/plain", () => ({ a: 1 }));
    built.get("/text", () => reply.text("raw"));
    built.get("/built-json", () => reply.json({ b: 2 }));

    seen.length = 0;
    assert.deepEqual((await built.inject("/plain")).json(), { a: 1 });
    assert.deepEqual(seen, ["preSerialization"]);

    seen.length = 0;
    assert.equal((await built.inject("/text")).body, "raw");
    assert.deepEqual(seen, []);

    seen.length = 0;
    assert.deepEqual((await built.inject("/built-json")).json(), { b: 2 });
    assert.deepEqual(seen, []);
  });
}

{
  const order: string[] = [];
  const app = createApp();

  app.addHook("onRequest", () => {
    order.push("onRequest:1");
  });
  app.addHook("onRequest", () => {
    order.push("onRequest:2");
  });
  app.addHook("preHandler", () => {
    order.push("preHandler:1");
  });
  app.addHook("preHandler", () => {
    order.push("preHandler:2");
  });

  app.get("/multi", () => reply.text("ok"));

  test("multiple hooks of the same name run in registration order", async () => {
    order.length = 0;
    await app.inject("/multi");
    assert.deepEqual(order, ["onRequest:1", "onRequest:2", "preHandler:1", "preHandler:2"]);
  });
}

{
  const reached: string[] = [];

  const fromOnRequest = createApp();
  fromOnRequest.addHook("onRequest", (req) => {
    if (req.path === "/blocked") return reply.text("stopped at onRequest", 401);
  });
  fromOnRequest.addHook("preHandler", () => {
    reached.push("preHandler");
  });
  fromOnRequest.get("/blocked", () => {
    reached.push("handler");
    return reply.text("never");
  });

  test("onRequest short-circuit skips later hooks and the handler", async () => {
    reached.length = 0;
    const res = await fromOnRequest.inject("/blocked");
    assert.equal(res.statusCode, 401);
    assert.equal(res.body, "stopped at onRequest");
    assert.deepEqual(reached, []);
  });

  const fromPreValidation = createApp();
  const seen: string[] = [];
  fromPreValidation.addHook("preValidation", () => reply.json({ gate: "preValidation" }, 403));
  fromPreValidation.addHook("preHandler", () => {
    seen.push("preHandler");
  });
  fromPreValidation.get("/guarded", () => {
    seen.push("handler");
    return reply.text("never");
  });

  test("preValidation short-circuit skips preHandler and the handler", async () => {
    seen.length = 0;
    const res = await fromPreValidation.inject("/guarded");
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { gate: "preValidation" });
    assert.deepEqual(seen, []);
  });
}

{
  const app = createApp();
  app.addHook("preSerialization", (_req, payload) => ({ data: payload, wrapped: true }));

  app.get("/obj", () => ({ id: 1 }));

  app.get(
    "/scoped",
    {
      preSerialization: [async (_req, payload) => ({ ...(payload as object), scoped: true })],
    },
    () => ({ ok: true }),
  );

  app.get("/text", () => reply.text("raw"));
  app.get("/built", () => reply.json({ untouched: true }));

  test("preSerialization wraps a plain object payload and sets JSON content-type", async () => {
    const res = await app.inject("/obj");
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(res.json(), { data: { id: 1 }, wrapped: true });
  });

  test("global then route-scoped preSerialization compose in registration order", async () => {
    const res = await app.inject("/scoped");
    assert.deepEqual(res.json(), { data: { ok: true }, wrapped: true, scoped: true });
  });

  test("string results bypass preSerialization", async () => {
    assert.equal((await app.inject("/text")).body, "raw");
  });

  test("built reply.json bypasses preSerialization", async () => {
    assert.deepEqual((await app.inject("/built")).json(), { untouched: true });
  });

  test("preSerialization can replace a payload with an array", async () => {
    const arr = createApp();
    arr.addHook("preSerialization", () => [1, 2, 3]);
    arr.get("/arr", () => ({ ignored: true }));
    assert.deepEqual((await arr.inject("/arr")).json(), [1, 2, 3]);
  });

  test("preSerialization can coerce a payload to null", async () => {
    const nul = createApp();
    nul.addHook("preSerialization", () => null);
    nul.get("/nul", () => ({ ignored: true }));
    const res = await nul.inject("/nul");
    assert.equal(res.json(), null);
  });
}

{
  const app = createApp();
  app.addHook("onResponse", (_req, res) => {
    if (res.status === 200 && typeof res.body === "string") {
      return reply.text(`${res.body}!`);
    }
  });
  app.addHook("onSend", (_req, res) => {
    if (typeof res.body === "string") {
      return reply.text(res.body.toUpperCase());
    }
  });
  app.get("/rewrite", () => reply.text("ok"));

  test("onResponse then onSend rewrite the body in order", async () => {
    assert.equal((await app.inject("/rewrite")).body, "OK!");
  });

  test("onSend sees the final headers (response header set by handler survives)", async () => {
    const hdr = createApp();
    let sawHeader: string | undefined;
    hdr.addHook("onSend", (req) => {
      sawHeader = req.path;
    });
    hdr.get("/h", (req) => {
      req.setResponseHeader("X-Custom", "1");
      return reply.text("ok");
    });
    const res = await hdr.inject("/h");
    assert.equal(res.headers["x-custom"], "1");
    assert.equal(sawHeader, "/h");
  });
}

{
  const fired: string[] = [];
  const app = createApp({ requestTimeoutMs: 60 });
  app.addHook("onTimeout", (req) => {
    fired.push(req.path);
  });

  app.get("/sync", () => reply.text("sync"));
  app.get("/over", async () => {
    await delay(250);
    return reply.text("over");
  });
  app.get("/under", async () => {
    await delay(5);
    return reply.text("under");
  });

  test("a synchronous handler never trips the timeout", async () => {
    fired.length = 0;
    const res = await app.inject("/sync");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "sync");
    assert.deepEqual(fired, []);
  });

  test("an overrunning handler yields 408 with the standard timeout body", async () => {
    fired.length = 0;
    const res = await app.inject("/over");
    assert.equal(res.statusCode, 408);
    assert.equal(res.statusMessage, "Request Timeout");
    assert.equal(res.body, "Request Timeout");
    assert.deepEqual(fired, ["/over"]);
  });

  test("onTimeout fires once per distinct timed-out request", async () => {
    fired.length = 0;
    await Promise.all([app.inject("/over"), app.inject("/over")]);
    assert.deepEqual(fired, ["/over", "/over"]);
  });

  test("a handler just under the budget is not timed out", async () => {
    fired.length = 0;
    const res = await app.inject("/under");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "under");
    assert.deepEqual(fired, []);
  });
}

{
  const fired: string[] = [];
  const app = createApp();
  app.addHook("onTimeout", (req) => {
    fired.push(req.path);
  });
  app.get("/slowish", async () => {
    await delay(120);
    return reply.text("done");
  });

  test("without requestTimeoutMs a slow handler completes and onTimeout stays silent", async () => {
    fired.length = 0;
    const res = await app.inject("/slowish");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "done");
    assert.deepEqual(fired, []);
  });
}

{
  const captured: Array<{ method: string; path: string }> = [];
  const app = createApp();
  app.addHook("onRequest", (req) => {
    captured.push({ method: req.method, path: req.path });
  });
  app.get("/users/:id", (req) => reply.json({ id: req.params.id }));
  app.post("/users", () => reply.text("created", 201));

  test("onRequest observes method and path for each request", async () => {
    captured.length = 0;
    const get = await app.inject("/users/7");
    const post = await app.inject({ method: "POST", url: "/users" });
    assert.deepEqual(get.json(), { id: "7" });
    assert.equal(post.statusCode, 201);
    assert.deepEqual(captured, [
      { method: "GET", path: "/users/7" },
      { method: "POST", path: "/users" },
    ]);
  });
}
