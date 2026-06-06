import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, parseCookies, reply, serializeCookie } from "../dist/index.js";

interface ValidationError {
  statusCode: number;
  error: string;
  message: string;
  errors: string[];
}

{
  const events: string[] = [];
  const app = createApp();

  app.onReady(() => {
    events.push("ready");
  });
  app.decorate("db", { find: (id: string) => ({ id, name: `user${id}` }) });
  app.decorateRequest("traceId", "T-1");

  app.addHook("preValidation", () => {
    events.push("preValidation");
  });
  app.addHook("onSend", (_req, res) => {
    events.push("onSend");
    return res;
  });

  app.get("/cookie/set", (req) => {
    req.setCookie("sid", "abc123", { httpOnly: true, sameSite: "Lax", maxAge: 3600 });
    return reply.text("set");
  });
  app.get("/cookie/read", (req) => reply.text(req.cookies.sid ?? "none"));

  app.get("/data", (req) => ({ ok: true, trace: (req as unknown as { traceId: string }).traceId }));

  app.post(
    "/users",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 2, errorMessage: { minLength: "name too short" } },
            age: { type: "integer", minimum: 0 },
          },
          errorMessage: { required: { name: "name is required" } },
        },
      },
    },
    (req) => ({ created: req.json<{ name: string }>().name }),
  );

  app.get(
    "/search",
    {
      schema: {
        query: { type: "object", properties: { limit: { type: "integer", maximum: 100 } } },
      },
    },
    (req) => ({ limit: Number(req.query.get("limit")) }),
  );

  app.get(
    "/filtered",
    { schema: { response: { 200: { type: "object", properties: { id: { type: "integer" } } } } } },
    () => ({ id: 7, secret: "hidden" }),
  );

  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.setErrorHandler((_req, err) => reply.json({ error: String((err as Error).message) }, 500));

  test("onReady ran before serving", async () => {
    await app.inject("/data");
    assert.ok(events.includes("ready"));
  });

  test("cookies: set and read", async () => {
    const set = await app.inject("/cookie/set");
    const header = (set.headers["set-cookie"] as string[])[0]!;
    assert.match(header, /sid=abc123/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Max-Age=3600/);

    const read = await app.inject({
      url: "/cookie/read",
      headers: { cookie: "sid=abc123; other=1" },
    });
    assert.equal(read.body, "abc123");
  });

  test("plain object return becomes JSON; decorators work", async () => {
    const r = await app.inject("/data");
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(r.json(), { ok: true, trace: "T-1" });
  });

  test("schema validation passes valid body", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/users",
      payload: { name: "alice", age: 30 },
    });
    assert.deepEqual(r.json(), { created: "alice" });
  });

  test("schema validation rejects with custom messages", async () => {
    const missing = await app.inject({ method: "POST", url: "/users", payload: { age: 5 } });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json<ValidationError>().message, /name is required/);

    const short = await app.inject({ method: "POST", url: "/users", payload: { name: "a" } });
    assert.match(short.json<ValidationError>().message, /name too short/);
  });

  test("query coercion + validation", async () => {
    assert.deepEqual((await app.inject("/search?limit=20")).json(), { limit: 20 });
    assert.equal((await app.inject("/search?limit=500")).statusCode, 400);
  });

  test("response schema drops extra fields", async () => {
    assert.deepEqual((await app.inject("/filtered")).json(), { id: 7 });
  });

  test("setErrorHandler catches thrown errors", async () => {
    const r = await app.inject("/boom");
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.json(), { error: "kaboom" });
  });

  test("preValidation and onSend hooks ran", async () => {
    events.length = 0;
    await app.inject("/data");
    assert.ok(events.includes("preValidation"));
    assert.ok(events.includes("onSend"));
  });
}

{
  const app = createApp();

  app.post(
    "/signup",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", errorMessage: { format: "bad email" } },
            password: { type: "string", minLength: 8 },
            role: {
              type: "string",
              enum: ["admin", "user"],
              errorMessage: { enum: "unknown role" },
            },
          },
          additionalProperties: false,
        },
      },
    },
    (req) => ({ email: req.json<{ email: string }>().email }),
  );

  test("validation 400 carries the full {statusCode,error,message,errors} envelope", async () => {
    const res = await app.inject({ method: "POST", url: "/signup", payload: { password: "x" } });
    assert.equal(res.statusCode, 400);
    const body = res.json<ValidationError>();
    assert.equal(body.statusCode, 400);
    assert.equal(body.error, "Bad Request");
    assert.ok(Array.isArray(body.errors));
    assert.ok(body.errors.length >= 2);
    assert.equal(body.message, body.errors.join("; "));
  });

  test("format, enum, and minLength custom messages all surface", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: { email: "not-an-email", password: "short", role: "root" },
    });
    const msg = res.json<ValidationError>().message;
    assert.match(msg, /bad email/);
    assert.match(msg, /at least 8/);
    assert.match(msg, /unknown role/);
  });

  test("additionalProperties:false rejects unknown keys", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: { email: "a@b.co", password: "longenough", extra: 1 },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<ValidationError>().message, /extra is not allowed/);
  });

  test("malformed JSON body is rejected as a validation error, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<ValidationError>().message, /body must be valid JSON/);
  });

  test("a valid signup passes through untouched", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: { email: "a@b.co", password: "longenough", role: "admin" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { email: "a@b.co" });
  });
}

{
  const app = createApp();

  app.get(
    "/items/:id",
    { schema: { params: { type: "object", properties: { id: { type: "integer", minimum: 1 } } } } },
    (req) => ({ id: Number(req.params.id), kind: typeof Number(req.params.id) }),
  );

  app.get(
    "/secure",
    {
      schema: {
        headers: {
          type: "object",
          required: ["x-api-key"],
          properties: { "x-api-key": { type: "string", minLength: 4 } },
          errorMessage: "api key required",
        },
      },
    },
    () => reply.text("ok"),
  );

  test("params coercion: numeric path segment validates as an integer", async () => {
    assert.deepEqual((await app.inject("/items/42")).json(), { id: 42, kind: "number" });
  });

  test("params validation rejects a non-numeric id against an integer schema", async () => {
    const res = await app.inject("/items/abc");
    assert.equal(res.statusCode, 400);
    assert.match(res.json<ValidationError>().message, /params\.id/);
  });

  test("params validation enforces minimum after coercion", async () => {
    assert.equal((await app.inject("/items/0")).statusCode, 400);
  });

  test("headers schema validates lowercased header names; string errorMessage wins", async () => {
    const ok = await app.inject({ url: "/secure", headers: { "x-api-key": "abcd" } });
    assert.equal(ok.statusCode, 200);

    const missing = await app.inject("/secure");
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json<ValidationError>().message, "api key required");
  });
}

{
  const app = createApp();

  app.get(
    "/products",
    {
      schema: {
        query: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1 },
            inStock: { type: "boolean" },
            tag: { type: "string" },
          },
        },
      },
    },
    (req) => ({
      page: Number(req.query.get("page") ?? 1),
      inStock: req.query.get("inStock"),
      tag: req.query.get("tag"),
    }),
  );

  test("integer query param coerces and passes minimum", async () => {
    assert.deepEqual((await app.inject("/products?page=3")).json(), {
      page: 3,
      inStock: null,
      tag: null,
    });
  });

  test("boolean query coercion accepts only 'true'/'false' literals", async () => {
    assert.equal((await app.inject("/products?inStock=true")).statusCode, 200);
    assert.equal((await app.inject("/products?inStock=yes")).statusCode, 400);
  });

  test("a missing optional query param is simply absent, not an error", async () => {
    assert.equal((await app.inject("/products")).statusCode, 200);
  });

  test("an integer query below minimum is rejected", async () => {
    assert.equal((await app.inject("/products?page=0")).statusCode, 400);
  });

  test("a non-numeric value for an integer field stays a string and fails type", async () => {
    const res = await app.inject("/products?page=oops");
    assert.equal(res.statusCode, 400);
    assert.match(res.json<ValidationError>().message, /query\.page/);
  });
}

{
  const app = createApp();

  app.get(
    "/profile",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              address: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          },
        },
      },
    },
    () => ({
      id: 1,
      name: "ada",
      password: "leaked",
      tags: ["a", "b"],
      address: { city: "london", zip: "SECRET" },
    }),
  );

  app.get(
    "/sparse",
    {
      schema: {
        response: {
          200: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } },
        },
      },
    },
    () => ({ a: 1 }),
  );

  test("response schema strips undeclared fields at every depth", async () => {
    const res = await app.inject("/profile");
    assert.deepEqual(res.json(), {
      id: 1,
      name: "ada",
      tags: ["a", "b"],
      address: { city: "london" },
    });
  });

  test("response schema omits absent declared fields rather than emitting null", async () => {
    const res = await app.inject("/sparse");
    assert.equal(res.body, '{"a":1}');
  });
}

{
  const app = createApp();

  app.get("/login", (req) => {
    req.setCookie("session", "v 1+&", {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/app",
    });
    req.setCookie("theme", "dark");
    return reply.text("in");
  });
  app.get("/logout", (req) => {
    req.clearCookie("session");
    return reply.text("out");
  });
  app.get("/whoami", (req) => reply.json(req.cookies));

  test("setCookie emits one Set-Cookie per call and URL-encodes the value", async () => {
    const res = await app.inject("/login");
    const cookies = res.headers["set-cookie"] as string[];
    assert.equal(cookies.length, 2);

    const session = cookies.find((c) => c.startsWith("session="))!;
    assert.match(session, /session=v%201%2B%26/);
    assert.match(session, /HttpOnly/);
    assert.match(session, /Secure/);
    assert.match(session, /SameSite=Strict/);
    assert.match(session, /Path=\/app/);

    assert.ok(cookies.some((c) => /^theme=dark/.test(c)));
  });

  test("clearCookie expires the cookie (Max-Age=0, epoch Expires)", async () => {
    const res = await app.inject("/logout");
    const cleared = (res.headers["set-cookie"] as string[])[0]!;
    assert.match(cleared, /session=;/);
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  });

  test("req.cookies parses an inbound Cookie header into an object", async () => {
    const res = await app.inject({ url: "/whoami", headers: { cookie: "a=1; b=hello%20world" } });
    assert.deepEqual(res.json(), { a: "1", b: "hello world" });
  });

  test("an empty cookie jar reads as {}", async () => {
    assert.deepEqual((await app.inject("/whoami")).json(), {});
  });

  test("parseCookies: first duplicate wins, quotes stripped, bare names skipped", () => {
    const jar = parseCookies('x="quoted"; x=second; =orphan; flag; y=2');
    assert.equal(jar.x, "quoted");
    assert.equal(jar.flag, "");
    assert.equal(jar.y, "2");
    assert.ok(!("" in jar));
  });

  test("serializeCookie throws on an invalid cookie name", () => {
    assert.throws(() => serializeCookie("bad name", "v"), /Invalid cookie name/);
  });
}

{
  const app = createApp();
  let counter = 0;

  app.decorate("config", { version: "1.2.3" });
  app.decorate("nextId", () => ++counter);
  app.decorateRequest("startedAt", 0);

  app.get("/version", () => ({ version: (app as any).config.version }));
  app.get("/id", () => ({ id: (app as any).nextId() }));
  app.get("/req-decoration", (req: any) => {
    req.startedAt = 999;
    return { startedAt: req.startedAt };
  });

  test("app.decorate exposes a value on the app instance", async () => {
    assert.deepEqual((await app.inject("/version")).json(), { version: "1.2.3" });
  });

  test("a decorated function shares state across requests", async () => {
    counter = 0;
    assert.deepEqual((await app.inject("/id")).json(), { id: 1 });
    assert.deepEqual((await app.inject("/id")).json(), { id: 2 });
  });

  test("decorateRequest is readable and writable per request", async () => {
    assert.deepEqual((await app.inject("/req-decoration")).json(), { startedAt: 999 });
  });

  test("per-request decorations do not bleed between requests", async () => {
    const app2 = createApp();
    let seen: number | undefined;
    app2.decorateRequest("token", 0);
    app2.get("/first", (req: any) => {
      req.token = 7;
      return reply.text("ok");
    });
    app2.get("/second", (req: any) => {
      seen = req.token;
      return reply.text("ok");
    });
    await app2.inject("/first");
    await app2.inject("/second");
    assert.equal(seen, 0);
  });
}

{
  test("the default error handler returns a plain 500", async () => {
    const app = createApp({ logger: false });
    app.get("/explode", () => {
      throw new Error("nope");
    });
    const res = await app.inject("/explode");
    assert.equal(res.statusCode, 500);
    assert.equal(res.body, "Internal Server Error");
  });

  test("a custom error handler can shape the error response", async () => {
    const app = createApp({ logger: false });
    app.setErrorHandler((req, err) =>
      reply.json({ path: req.path, message: (err as Error).message }, 422),
    );
    app.get("/fail", () => {
      throw new Error("validation blew up");
    });
    const res = await app.inject("/fail");
    assert.equal(res.statusCode, 422);
    assert.deepEqual(res.json(), { path: "/fail", message: "validation blew up" });
  });

  test("a rejected async handler is routed through the error handler", async () => {
    const app = createApp({ logger: false });
    app.setErrorHandler((_req, err) => reply.json({ async: (err as Error).message }, 503));
    app.get("/async-fail", async () => {
      await Promise.resolve();
      throw new Error("later");
    });
    const res = await app.inject("/async-fail");
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { async: "later" });
  });

  test("an error handler that itself throws falls back to the default 500", async () => {
    const app = createApp({ logger: false });
    app.onError(() => {
      throw new Error("handler is broken too");
    });
    app.get("/double-fail", () => {
      throw new Error("original");
    });
    const res = await app.inject("/double-fail");
    assert.equal(res.statusCode, 500);
    assert.equal(res.body, "Internal Server Error");
  });
}

{
  test("hooks run onRequest → preValidation → preHandler → handler in order", async () => {
    const order: string[] = [];
    const app = createApp();
    app.addHook("onRequest", () => {
      order.push("onRequest");
    });
    app.addHook("preValidation", () => {
      order.push("preValidation");
    });
    app.addHook("preHandler", () => {
      order.push("preHandler");
    });
    app.get("/ordered", () => {
      order.push("handler");
      return reply.text("ok");
    });
    await app.inject("/ordered");
    assert.deepEqual(order, ["onRequest", "preValidation", "preHandler", "handler"]);
  });

  test("a preHandler hook that returns a value short-circuits the handler", async () => {
    const reached: string[] = [];
    const app = createApp();
    app.addHook("preHandler", (req) => {
      if (req.headers.get("x-block") === "1") return reply.text("blocked", 403);
    });
    app.get("/maybe", () => {
      reached.push("handler");
      return reply.text("ran");
    });

    const blocked = await app.inject({ url: "/maybe", headers: { "x-block": "1" } });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.body, "blocked");
    assert.deepEqual(reached, []);

    const allowed = await app.inject("/maybe");
    assert.equal(allowed.body, "ran");
    assert.deepEqual(reached, ["handler"]);
  });

  test("preSerialization can rewrite the payload before it is serialized", async () => {
    const app = createApp();
    app.addHook("preSerialization", (_req, payload) => ({ wrapped: payload }));
    app.get("/wrap", () => ({ id: 1 }));
    assert.deepEqual((await app.inject("/wrap")).json(), { wrapped: { id: 1 } });
  });

  test("onSend can mutate the outgoing response body", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, res) => {
      if (typeof res.body === "string") return reply.text(res.body.toUpperCase(), res.status);
    });
    app.get("/shout", () => reply.text("quiet"));
    assert.equal((await app.inject("/shout")).body, "QUIET");
  });

  test("validation runs after preValidation but before preHandler", async () => {
    const order: string[] = [];
    const app = createApp();
    app.addHook("preValidation", () => {
      order.push("preValidation");
    });
    app.addHook("preHandler", () => {
      order.push("preHandler");
    });
    app.post(
      "/checked",
      {
        schema: {
          body: { type: "object", required: ["x"], properties: { x: { type: "integer" } } },
        },
      },
      () => {
        order.push("handler");
        return reply.text("ok");
      },
    );

    order.length = 0;
    const bad = await app.inject({ method: "POST", url: "/checked", payload: {} });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(order, ["preValidation"]);

    order.length = 0;
    const good = await app.inject({ method: "POST", url: "/checked", payload: { x: 1 } });
    assert.equal(good.statusCode, 200);
    assert.deepEqual(order, ["preValidation", "preHandler", "handler"]);
  });
}

{
  // ReDoS guard: a catastrophic-backtracking pattern run against a long attacker string
  // would pin the event loop. schema.ts caps the input length (the schema's maxLength, or
  // PATTERN_INPUT_CAP=4096) and fails without running the regex. The proof is that this
  // test *finishes promptly* — a regression would hang the suite, not just flip an assert.
  const app = createApp();
  app.post(
    "/redos",
    {
      schema: {
        body: { type: "object", properties: { code: { type: "string", pattern: "^(a+)+$" } } },
      },
    },
    (req) => ({ code: req.json<{ code: string }>().code }),
  );

  test("a pathological pattern against an oversized value fails fast (ReDoS guard)", async () => {
    const huge = await app.inject({
      method: "POST",
      url: "/redos",
      payload: { code: "a".repeat(8192) },
    });
    assert.equal(huge.statusCode, 400); // rejected without ever running the regex
    assert.match(huge.json<ValidationError>().message, /code must match/);
  });

  test("a short value that satisfies the same pattern still matches", async () => {
    const ok = await app.inject({ method: "POST", url: "/redos", payload: { code: "aaa" } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { code: "aaa" });
  });
}

{
  test("the default 404 fires for an unmapped route", async () => {
    const app = createApp();
    app.get("/known", () => reply.text("ok"));
    const res = await app.inject("/unknown");
    assert.equal(res.statusCode, 404);
  });

  test("a custom not-found handler shapes the 404", async () => {
    const app = createApp();
    app.setNotFoundHandler((req) => reply.json({ missing: req.path }, 404));
    const res = await app.inject("/ghost");
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { missing: "/ghost" });
  });
}
