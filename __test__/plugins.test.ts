import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, reply } from "../dist/index.js";
import { freePort } from "./helpers.ts";

{
  const order: string[] = [];
  const app = createApp({ logger: false });

  app.addHook("onRequest", () => {
    order.push("root:onRequest");
  });

  app.register(
    (api, opts) => {
      api.decorateRequest("scope", opts.tag);
      api.addHook("onRequest", () => {
        order.push("api:onRequest");
      });
      api.get("/ping", (req: any) => reply.json({ scope: req.scope, prefix: opts.prefix }));

      api.register(
        (v1) => {
          v1.get("/users", () => reply.json({ users: ["a"] }));
        },
        { prefix: "/v1" },
      );
    },
    { prefix: "/api", tag: "API" },
  );

  app.register(async (mod) => {
    await Promise.resolve();
    mod.get("/async", () => reply.text("async-loaded"));
  });

  app.get("/root", (req: any) => reply.json({ scope: req.scope ?? null }));

  test("plugin route is mounted under its prefix with encapsulated decorator", async () => {
    await app.ready();
    const r = await app.inject("/api/ping");
    assert.deepEqual(r.json(), { scope: "API", prefix: "/api" });
  });

  test("nested plugin inherits parent prefix and hooks (outer → inner)", async () => {
    await app.ready();
    order.length = 0;
    const r = await app.inject("/api/v1/users");
    assert.deepEqual(r.json(), { users: ["a"] });
    assert.deepEqual(order, ["root:onRequest", "api:onRequest"]);
  });

  test("async plugin loaded via app.ready()", async () => {
    await app.ready();
    const r = await app.inject("/async");
    assert.equal(r.body, "async-loaded");
  });

  test("encapsulation: root route does not see plugin's decorator/hook", async () => {
    await app.ready();
    order.length = 0;
    const r = await app.inject("/root");
    assert.deepEqual(r.json(), { scope: null });
    assert.deepEqual(order, ["root:onRequest"]);
  });
}

{
  const app = createApp({ logger: false });

  app.register(
    (svc, opts) => {
      svc.get("/cfg", () =>
        reply.json({ prefix: opts.prefix, version: opts.version, flag: opts.flag }),
      );
    },
    { prefix: "/svc", version: 2, flag: true },
  );

  test("custom register opts pass through to the plugin alongside prefix", async () => {
    await app.ready();
    const r = await app.inject("/svc/cfg");
    assert.deepEqual(r.json(), { prefix: "/svc", version: 2, flag: true });
  });
}

{
  const app = createApp({ logger: false });

  app.register((p) => {
    p.get("/bare", () => reply.text("at-root"));
  });

  app.register((p) => {
    p.get("/empty", () => reply.text("also-root"));
  }, {});

  test("a plugin without a prefix mounts its routes at the root path", async () => {
    await app.ready();
    const bare = await app.inject("/bare");
    const empty = await app.inject("/empty");
    assert.equal(bare.statusCode, 200);
    assert.equal(bare.body, "at-root");
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.body, "also-root");
  });
}

{
  const app = createApp({ logger: false });

  app.register(
    (api) => {
      api.get("/health", () => reply.text("ok"));
    },
    { prefix: "/api" },
  );

  test("prefix is enforced: the un-prefixed path is a 404", async () => {
    await app.ready();
    const ok = await app.inject("/api/health");
    const miss = await app.inject("/health");
    assert.equal(ok.statusCode, 200);
    assert.equal(miss.statusCode, 404);
  });
}

{
  const app = createApp({ logger: false });

  app.register(
    (api) => {
      api.get("/u/:id", (req) => reply.json({ id: req.params.id, q: req.query.get("x") }));
    },
    { prefix: "/v1" },
  );

  test("route params and query survive prefix mounting", async () => {
    await app.ready();
    const r = await app.inject("/v1/u/42?x=9");
    assert.deepEqual(r.json(), { id: "42", q: "9" });
  });
}

{
  const order: string[] = [];
  const app = createApp({ logger: false });

  app.addHook("onRequest", () => {
    order.push("root");
  });
  app.decorateRequest("rootDeco", "fromRoot");

  app.register(
    (api) => {
      api.addHook("onRequest", () => {
        order.push("api");
      });
      api.decorateRequest("scope", "API");

      api.register(
        (v1) => {
          v1.addHook("onRequest", () => {
            order.push("v1");
          });
          v1.decorateRequest("scope", "V1");
          v1.get("/users", (req: any) => reply.json({ scope: req.scope, rootDeco: req.rootDeco }));
        },
        { prefix: "/v1" },
      );

      api.get("/ping", (req: any) => reply.json({ scope: req.scope, rootDeco: req.rootDeco }));
    },
    { prefix: "/api" },
  );

  test("nested prefixes compose: /api + /v1 → /api/v1", async () => {
    await app.ready();
    const r = await app.inject("/api/v1/users");
    assert.equal(r.statusCode, 200);
  });

  test("root decorator flows down into nested plugins", async () => {
    await app.ready();
    const r = await app.inject("/api/v1/users");
    assert.equal((r.json() as any).rootDeco, "fromRoot");
  });

  test("leaf scope wins when a decorator name conflicts with an ancestor", async () => {
    await app.ready();
    const deep = await app.inject("/api/v1/users");
    const shallow = await app.inject("/api/ping");
    assert.equal((deep.json() as any).scope, "V1");
    assert.equal((shallow.json() as any).scope, "API");
  });

  test("hooks run outermost → innermost across three levels of nesting", async () => {
    await app.ready();
    order.length = 0;
    await app.inject("/api/v1/users");
    assert.deepEqual(order, ["root", "api", "v1"]);
  });

  test("a route one level up does not run the deeper plugin's hooks", async () => {
    await app.ready();
    order.length = 0;
    await app.inject("/api/ping");
    assert.deepEqual(order, ["root", "api"]);
  });
}

{
  const seen: string[] = [];
  const app = createApp({ logger: false });

  app.register(
    (a) => {
      a.decorateRequest("who", "A");
      a.addHook("onRequest", () => {
        seen.push("A");
      });
      a.get("/x", (req: any) => reply.json({ who: req.who ?? null, other: req.other ?? null }));
    },
    { prefix: "/a" },
  );

  app.register(
    (b) => {
      b.decorateRequest("other", "B");
      b.addHook("onRequest", () => {
        seen.push("B");
      });
      b.get("/x", (req: any) => reply.json({ who: req.who ?? null, other: req.other ?? null }));
    },
    { prefix: "/b" },
  );

  test("sibling plugins do not see each other's request decorators", async () => {
    await app.ready();
    const a = await app.inject("/a/x");
    const b = await app.inject("/b/x");
    assert.deepEqual(a.json(), { who: "A", other: null });
    assert.deepEqual(b.json(), { who: null, other: "B" });
  });

  test("sibling plugins do not run each other's hooks", async () => {
    await app.ready();
    seen.length = 0;
    await app.inject("/a/x");
    const afterA = [...seen];
    seen.length = 0;
    await app.inject("/b/x");
    const afterB = [...seen];
    assert.deepEqual(afterA, ["A"]);
    assert.deepEqual(afterB, ["B"]);
  });
}

{
  const loadOrder: string[] = [];
  const app = createApp({ logger: false });

  app.register(async (p) => {
    await Promise.resolve();
    loadOrder.push("first");
    p.get("/first", () => reply.text("1"));
  });

  app.register(async (p) => {
    await new Promise((r) => setTimeout(r, 5));
    loadOrder.push("second");
    p.get("/second", () => reply.text("2"));
  });

  test("async plugins load in registration order during ready()", async () => {
    await app.ready();
    assert.deepEqual(loadOrder, ["first", "second"]);
    const a = await app.inject("/first");
    const b = await app.inject("/second");
    assert.equal(a.body, "1");
    assert.equal(b.body, "2");
  });
}

{
  const app = createApp({ logger: false });
  let loadCount = 0;
  let readyHooks = 0;

  app.onReady(() => {
    readyHooks++;
  });
  app.register((p) => {
    loadCount++;
    p.get("/once", () => reply.text("once"));
  });

  test("ready() loads plugins once; onReady fires once at first listen", async () => {
    await app.ready();
    await app.ready();
    await app.ready();
    assert.equal(loadCount, 1);
    assert.equal(readyHooks, 0);

    const r1 = await app.inject("/once");
    const r2 = await app.inject("/once");
    assert.equal(r1.body, "once");
    assert.equal(r2.body, "once");
    assert.equal(loadCount, 1);
    assert.equal(readyHooks, 1);
  });
}

{
  const app = createApp({ logger: false });
  app.register(async (mod) => {
    await Promise.resolve();
    mod.get("/late", () => reply.text("late"));
  });

  test("listen() before ready() throws when an async plugin is registered", () => {
    assert.throws(() => {
      const handle = app.listen(0, { host: "127.0.0.1" });
      handle.close();
    }, /async plugin/i);
  });
}

{
  const app = createApp({ logger: false });
  app.register((mod) => {
    mod.get("/sync", () => reply.text("sync"));
  });

  test("a purely synchronous plugin needs no explicit ready() before inject", async () => {
    const r = await app.inject("/sync");
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, "sync");
  });
}

{
  const app = createApp({ logger: false });

  app.setErrorHandler((_req, err) =>
    reply.json({ where: "root", msg: err instanceof Error ? err.message : String(err) }, 500),
  );

  app.register(
    (api) => {
      api.setErrorHandler((_req, err) =>
        reply.json({ where: "plugin", msg: err instanceof Error ? err.message : String(err) }, 503),
      );
      api.get("/boom", () => {
        throw new Error("plugin-boom");
      });
    },
    { prefix: "/api" },
  );

  app.get("/boom", () => {
    throw new Error("root-boom");
  });

  test("a plugin's error handler overrides the root handler for its routes", async () => {
    await app.ready();
    const r = await app.inject("/api/boom");
    assert.equal(r.statusCode, 503);
    assert.deepEqual(r.json(), { where: "plugin", msg: "plugin-boom" });
  });

  test("a route outside the plugin still uses the root error handler", async () => {
    await app.ready();
    const r = await app.inject("/boom");
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.json(), { where: "root", msg: "root-boom" });
  });
}

{
  const app = createApp({ logger: false });

  app.register(
    (api) => {
      api.addHook("preSerialization", (_req, payload: any) => ({ ...payload, stamped: true }));
      api.get("/data", () => ({ ok: 1 }));
    },
    { prefix: "/api" },
  );

  app.get("/data", () => ({ ok: 1 }));

  test("a plugin's preSerialization hook stamps only its own payloads", async () => {
    await app.ready();
    const inside = await app.inject("/api/data");
    const outside = await app.inject("/data");
    assert.deepEqual(inside.json(), { ok: 1, stamped: true });
    assert.deepEqual(outside.json(), { ok: 1 });
  });
}

{
  const app = createApp({ logger: false });

  app.register(
    (api) => {
      api.addHook("onSend", (req) => {
        req.setResponseHeader("x-plugin", "yes");
      });
      api.get("/h", () => reply.text("hi"));
    },
    { prefix: "/api" },
  );

  app.get("/h", () => reply.text("hi"));

  test("a plugin's onSend hook sets headers only on its own responses", async () => {
    await app.ready();
    const inside = await app.inject("/api/h");
    const outside = await app.inject("/h");
    assert.equal(inside.headers["x-plugin"], "yes");
    assert.equal(outside.headers["x-plugin"], undefined);
  });
}

{
  const app = createApp({ logger: false });

  app.register(
    (api) => {
      api.addContentTypeParser("text/csv", (_req, body) => {
        const text = Buffer.from(body).toString("utf8");
        return text.split(",");
      });
      api.post("/csv", async (req) => reply.json(await req.parseBody()));
    },
    { prefix: "/api" },
  );

  app.post("/csv", async (req) => {
    const parsed = await req.parseBody();
    return reply.json({ parsedType: typeof parsed, isArray: Array.isArray(parsed) });
  });

  test("a plugin's content-type parser is scoped to its routes", async () => {
    await app.ready();
    const inside = await app.inject({
      method: "POST",
      url: "/api/csv",
      headers: { "content-type": "text/csv" },
      payload: "a,b,c",
    });
    assert.deepEqual(inside.json(), ["a", "b", "c"]);

    const outside = await app.inject({
      method: "POST",
      url: "/csv",
      headers: { "content-type": "text/csv" },
      payload: "a,b,c",
    });
    assert.notDeepEqual(outside.json(), ["a", "b", "c"]);
  });
}

{
  const app = createApp({ logger: false });

  app.register((api) => {
    api.decorate("config", { feature: "on" });
    api.get("/d", () => reply.text("d"));
  });

  test("app.decorate from inside a plugin is visible app-globally", async () => {
    await app.ready();
    assert.deepEqual((app as any).config, { feature: "on" });
  });
}

{
  const app = createApp({ logger: false });
  app.register(
    (api) => {
      api.get("/live", () => reply.text("live"));
    },
    { prefix: "/api" },
  );

  test("plugin route is reachable over a real listening socket", async () => {
    await app.ready();
    const port = await freePort();
    const handle = app.listen(port, { host: "127.0.0.1" });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/live`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "live");
    } finally {
      handle.close();
    }
  });
}
