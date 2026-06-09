import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, reply } from "../ts/index.ts";

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
    const res = await app.inject("/text");
    assert.equal(res.body, "raw");
    assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  });

  test("built reply.json bypasses preSerialization", async () => {
    assert.deepEqual((await app.inject("/built")).json(), { untouched: true });
  });
}

{
  const seen: unknown[] = [];
  const app = createApp();
  app.addHook("preSerialization", (_req, payload) => {
    seen.push(payload);
    return payload;
  });

  app.get("/obj", () => ({ a: 1 }));
  app.get("/arr", () => [1, 2, 3]);
  app.get("/num", () => 42);
  app.get("/bool", () => false);
  app.get("/null", () => null);
  app.get("/text", () => reply.text("raw"));
  app.get("/built", () => reply.json({ b: 2 }));
  app.get("/empty", () => reply.empty());

  test("an object payload reaches the hook unchanged", async () => {
    seen.length = 0;
    assert.deepEqual((await app.inject("/obj")).json(), { a: 1 });
    assert.deepEqual(seen, [{ a: 1 }]);
  });

  test("an array payload reaches the hook and serializes as a JSON array", async () => {
    seen.length = 0;
    assert.deepEqual((await app.inject("/arr")).json(), [1, 2, 3]);
    assert.deepEqual(seen, [[1, 2, 3]]);
  });

  test("a number payload reaches the hook and serializes as bare JSON", async () => {
    seen.length = 0;
    const res = await app.inject("/num");
    assert.equal(res.body, "42");
    assert.deepEqual(seen, [42]);
  });

  test("a boolean payload reaches the hook and serializes as bare JSON", async () => {
    seen.length = 0;
    const res = await app.inject("/bool");
    assert.equal(res.body, "false");
    assert.deepEqual(seen, [false]);
  });

  test("a null payload reaches the hook and serializes as JSON null", async () => {
    seen.length = 0;
    const res = await app.inject("/null");
    assert.equal(res.body, "null");
    assert.deepEqual(seen, [null]);
  });

  test("a string result skips the hook entirely", async () => {
    seen.length = 0;
    assert.equal((await app.inject("/text")).body, "raw");
    assert.deepEqual(seen, []);
  });

  test("a built reply.json skips the hook entirely", async () => {
    seen.length = 0;
    assert.deepEqual((await app.inject("/built")).json(), { b: 2 });
    assert.deepEqual(seen, []);
  });

  test("a built reply.empty (204) skips the hook entirely", async () => {
    seen.length = 0;
    const res = await app.inject("/empty");
    assert.equal(res.statusCode, 204);
    assert.deepEqual(seen, []);
  });
}

{
  const order: string[] = [];
  const app = createApp();
  app.addHook("preSerialization", (_req, p) => {
    order.push("first");
    return { ...(p as object), first: true };
  });
  app.addHook("preSerialization", (_req, p) => {
    order.push("second");
    return { ...(p as object), second: true };
  });
  app.get("/chain", () => ({ base: true }));

  test("multiple global preSerialization hooks thread the payload in order", async () => {
    order.length = 0;
    const res = await app.inject("/chain");
    assert.deepEqual(res.json(), { base: true, first: true, second: true });
    assert.deepEqual(order, ["first", "second"]);
  });
}

{
  const app = createApp();
  app.addHook("preSerialization", async (_req, p) => {
    await Promise.resolve();
    return { wrapped: p };
  });

  app.get(
    "/mixed",
    {
      preSerialization: [
        (_req, p) => ({ ...(p as object), sync: true }),
        async (_req, p) => {
          await Promise.resolve();
          return { ...(p as object), async: true };
        },
      ],
    },
    () => ({ ok: true }),
  );

  test("async global + mixed sync/async route hooks compose in order", async () => {
    const res = await app.inject("/mixed");
    assert.deepEqual(res.json(), { wrapped: { ok: true }, sync: true, async: true });
  });

  test("a single async global hook resolves before serialization", async () => {
    const single = createApp();
    single.addHook("preSerialization", async (_req, p) => {
      await new Promise((r) => setTimeout(r, 5));
      return { delayed: p };
    });
    single.get("/d", () => ({ v: 9 }));
    assert.deepEqual((await single.inject("/d")).json(), { delayed: { v: 9 } });
  });
}

{
  test("a hook can replace an object payload with an array", async () => {
    const app = createApp();
    app.addHook("preSerialization", () => [1, 2, 3]);
    app.get("/x", () => ({ ignored: true }));
    assert.deepEqual((await app.inject("/x")).json(), [1, 2, 3]);
  });

  test("a hook can coerce a payload to null", async () => {
    const app = createApp();
    app.addHook("preSerialization", () => null);
    app.get("/x", () => ({ ignored: true }));
    assert.equal((await app.inject("/x")).json(), null);
  });

  test("a hook can coerce a payload to a number", async () => {
    const app = createApp();
    app.addHook("preSerialization", () => 7);
    app.get("/x", () => ({ ignored: true }));
    assert.equal((await app.inject("/x")).body, "7");
  });
}

{
  test("a hook returning a string yields a text/plain response, not JSON", async () => {
    const app = createApp();
    app.addHook("preSerialization", () => "now a string");
    app.get("/x", () => ({ x: 1 }));
    const res = await app.inject("/x");
    assert.equal(res.body, "now a string");
    assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  });

  test("a hook returning a built reply.json honors its custom status", async () => {
    const app = createApp();
    app.addHook("preSerialization", () => reply.json({ replaced: true }, 418));
    app.get("/x", () => ({ x: 1 }));
    const res = await app.inject("/x");
    assert.equal(res.statusCode, 418);
    assert.deepEqual(res.json(), { replaced: true });
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  });
}

{
  const app = createApp();
  app.addHook("preSerialization", (req, payload) => ({
    payload,
    path: req.path,
    method: req.method,
    who: req.query.get("who") ?? "anon",
  }));
  app.get("/users/:id", (req) => ({ id: req.params.id }));

  test("the hook can read request path, method and query", async () => {
    const res = await app.inject("/users/42?who=neo");
    assert.deepEqual(res.json(), {
      payload: { id: "42" },
      path: "/users/42",
      method: "GET",
      who: "neo",
    });
  });
}

{
  const app = createApp();
  app.addHook("preSerialization", (_req, p) => ({ g: p }));
  app.get("/plain", () => ({ v: 1 }));
  app.get(
    "/decorated",
    { preSerialization: [(_req, p) => ({ ...(p as object), r: true })] },
    () => ({ v: 2 }),
  );

  test("a route without a scoped hook gets only the global hook", async () => {
    assert.deepEqual((await app.inject("/plain")).json(), { g: { v: 1 } });
  });

  test("a route with a scoped hook gets global then scoped (scoped sees global's output)", async () => {
    assert.deepEqual((await app.inject("/decorated")).json(), { g: { v: 2 }, r: true });
  });
}

{
  const app = createApp();
  app.get("/x", () => ({ a: 1 }));

  test("without any preSerialization hook an object serializes directly", async () => {
    const res = await app.inject("/x");
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(res.json(), { a: 1 });
  });
}

{
  test("a plugin-scoped hook composes with the root hook only inside the plugin", async () => {
    const app = createApp();
    app.addHook("preSerialization", (_req, p) => ({ g: p }));
    app.register(
      (inst) => {
        inst.addHook("preSerialization", (_req, p) => ({ ...(p as object), plug: true }));
        inst.get("/in", () => ({ v: 1 }));
      },
      { prefix: "/v1" },
    );
    app.get("/out", () => ({ v: 2 }));
    await app.ready();

    assert.deepEqual((await app.inject("/v1/in")).json(), { g: { v: 1 }, plug: true });
    assert.deepEqual((await app.inject("/out")).json(), { g: { v: 2 } });
  });
}

{
  test("group routes inherit the root preSerialization hook", async () => {
    const app = createApp();
    app.addHook("preSerialization", (_req, p) => ({ g: p }));
    app.group("/api", (g) => {
      g.get("/in", () => ({ v: 1 }));
    });
    app.get("/out", () => ({ v: 2 }));

    assert.deepEqual((await app.inject("/api/in")).json(), { g: { v: 1 } });
    assert.deepEqual((await app.inject("/out")).json(), { g: { v: 2 } });
  });
}

{
  test("the not-found handler's plain payload runs through preSerialization", async () => {
    const app = createApp();
    app.addHook("preSerialization", (_req, p) => ({ wrapped: p }));
    app.setNotFoundHandler(() => ({ missing: true }));
    const res = await app.inject("/nope");
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { wrapped: { missing: true } });
  });

  test("a not-found handler returning a built reply bypasses preSerialization", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("preSerialization", (_req, p) => {
      ran++;
      return p;
    });
    app.setNotFoundHandler(() => reply.json({ missing: true }, 404));
    const res = await app.inject("/nope");
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { missing: true });
    assert.equal(ran, 0);
  });
}

{
  test("a thrown handler routed to an error reply bypasses preSerialization", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("preSerialization", (_req, p) => {
      ran++;
      return p;
    });
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    app.setErrorHandler(() => reply.json({ err: true }, 500));
    const res = await app.inject("/boom");
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { err: true });
    assert.equal(ran, 0);
  });

  test("the default 500 from a throwing handler bypasses preSerialization", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("preSerialization", (_req, p) => {
      ran++;
      return p;
    });
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    const res = await app.inject("/boom");
    assert.equal(res.statusCode, 500);
    assert.equal(res.body, "Internal Server Error");
    assert.equal(ran, 0);
  });
}

{
  test("a synchronously throwing hook produces a 500", async () => {
    const app = createApp();
    app.addHook("preSerialization", () => {
      throw new Error("hook blew up");
    });
    app.get("/x", () => ({ v: 1 }));
    const res = await app.inject("/x");
    assert.equal(res.statusCode, 500);
  });

  test("an async-rejecting hook produces a 500", async () => {
    const app = createApp();
    app.addHook("preSerialization", async () => {
      throw new Error("async hook blew up");
    });
    app.get("/x", () => ({ v: 1 }));
    const res = await app.inject("/x");
    assert.equal(res.statusCode, 500);
  });
}

{
  test("a stream response bypasses preSerialization", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("preSerialization", (_req, p) => {
      ran++;
      return p;
    });
    app.get("/stream", () =>
      reply.stream(
        (async function* () {
          yield "a";
          yield "b";
          yield "c";
        })(),
        { contentType: "text/plain" },
      ),
    );
    const res = await app.inject("/stream");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "abc");
    assert.equal(ran, 0);
  });
}

{
  const app = createApp();
  let ran = 0;
  app.addHook("preSerialization", (_req, p) => {
    ran++;
    return p;
  });
  app.get("/bytes", () => reply.bytes(new TextEncoder().encode("hi"), "application/octet-stream"));
  app.get("/html", () => reply.html("<b>hi</b>"));
  app.get("/redirect", () => reply.redirect("/elsewhere"));

  test("reply.bytes bypasses preSerialization", async () => {
    ran = 0;
    const res = await app.inject("/bytes");
    assert.equal(res.statusCode, 200);
    assert.equal(ran, 0);
  });

  test("reply.html bypasses preSerialization", async () => {
    ran = 0;
    const res = await app.inject("/html");
    assert.equal(res.body, "<b>hi</b>");
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(ran, 0);
  });

  test("reply.redirect bypasses preSerialization", async () => {
    ran = 0;
    const res = await app.inject("/redirect");
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers["location"], "/elsewhere");
    assert.equal(ran, 0);
  });
}

{
  test("an empty-string result bypasses preSerialization", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("preSerialization", (_req, p) => {
      ran++;
      return p;
    });
    app.get("/empty-str", () => "");
    const res = await app.inject("/empty-str");
    assert.equal(res.body, "");
    assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(ran, 0);
  });
}

{
  test("preSerialization runs before response-schema serialization", async () => {
    const app = createApp();
    app.addHook("preSerialization", (_req, p) => ({ ...(p as object), injected: "kept" }));
    app.get(
      "/schema",
      {
        schema: {
          response: {
            200: {
              type: "object",
              properties: { id: { type: "number" }, injected: { type: "string" } },
            },
          },
        },
      },
      () => ({ id: 1, dropped: "x" }),
    );
    const res = await app.inject("/schema");
    assert.deepEqual(res.json(), { id: 1, injected: "kept" });
  });
}

{
  test("an async handler's resolved object flows through the hook", async () => {
    const app = createApp();
    app.addHook("preSerialization", (_req, p) => ({ wrapped: p }));
    app.get("/async", async () => {
      await Promise.resolve();
      return { v: 1 };
    });
    assert.deepEqual((await app.inject("/async")).json(), { wrapped: { v: 1 } });
  });

  test("an async handler that resolves to a string bypasses the hook", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("preSerialization", (_req, p) => {
      ran++;
      return p;
    });
    app.get("/async-str", async () => {
      await Promise.resolve();
      return "plain";
    });
    const res = await app.inject("/async-str");
    assert.equal(res.body, "plain");
    assert.equal(ran, 0);
  });

  test("an async handler that resolves to a built reply bypasses the hook", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("preSerialization", (_req, p) => {
      ran++;
      return p;
    });
    app.get("/async-built", async () => {
      await Promise.resolve();
      return reply.json({ built: true }, 201);
    });
    const res = await app.inject("/async-built");
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), { built: true });
    assert.equal(ran, 0);
  });
}
