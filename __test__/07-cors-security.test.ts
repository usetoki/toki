import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { cors, reply, securityHeaders } from "../ts";
import { withServer, type RunningServer } from "./helpers";

describe("cors middleware", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer((app) => {
      app.use(
        cors({
          origin: ["https://allowed.example"],
          methods: ["GET", "POST", "OPTIONS"],
          allowedHeaders: ["content-type", "authorization"],
          exposedHeaders: ["x-request-id"],
          credentials: true,
          maxAge: 600,
        }),
      );
      app.get("/data", () => reply.json({ ok: true }));
      // A real OPTIONS route is needed: the native router 405s an unregistered
      // method, so the preflight must reach JS where cors() short-circuits it.
      app.options("/data", () => reply.empty(204));
    });
  });

  after(() => server.close());

  test("reflects an allowed origin and varies on Origin", async () => {
    const res = await fetch(`${server.base}/data`, {
      headers: { origin: "https://allowed.example" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "https://allowed.example");
    assert.equal(res.headers.get("vary"), "Origin");
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.equal(res.headers.get("access-control-expose-headers"), "x-request-id");
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("a disallowed origin gets no allow-origin header", async () => {
    const res = await fetch(`${server.base}/data`, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("a preflight OPTIONS is answered with the configured allow lists", async () => {
    const res = await fetch(`${server.base}/data`, {
      method: "OPTIONS",
      headers: {
        origin: "https://allowed.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://allowed.example");
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    assert.equal(res.headers.get("access-control-allow-headers"), "content-type, authorization");
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.equal(res.headers.get("access-control-max-age"), "600");
    await res.body?.cancel();
  });

  test("a non-preflight OPTIONS falls through to the handler", async () => {
    // No Access-Control-Request-Method, so cors() does not short-circuit.
    const res = await fetch(`${server.base}/data`, {
      method: "OPTIONS",
      headers: { origin: "https://allowed.example" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://allowed.example");
    await res.body?.cancel();
  });
});

describe("cors wildcard origin", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer((app) => {
      app.use(cors());
      app.get("/data", () => reply.json({ ok: true }));
    });
  });

  after(() => server.close());

  test("a default wildcard allows any origin without a Vary", async () => {
    const res = await fetch(`${server.base}/data`, { headers: { origin: "https://any.example" } });
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    // A wildcard origin must not vary on Origin.
    assert.equal(res.headers.get("vary"), null);
    await res.body?.cancel();
  });
});

describe("security headers", () => {
  test("applies sensible defaults", async () => {
    const server = await withServer((app) => {
      app.use(securityHeaders());
      app.get("/", () => reply.text("ok"));
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-dns-prefetch-control"), "off");
      // HSTS and CSP are off by default.
      assert.equal(res.headers.get("strict-transport-security"), null);
      assert.equal(res.headers.get("content-security-policy"), null);
      await res.body?.cancel();
    } finally {
      server.close();
    }
  });

  test("applies custom HSTS and CSP and honors disabled defaults", async () => {
    const server = await withServer((app) => {
      app.use(
        securityHeaders({
          hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
          contentSecurityPolicy: "default-src 'self'",
          frameOptions: "DENY",
          referrerPolicy: false,
        }),
      );
      app.get("/", () => reply.text("ok"));
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(
        res.headers.get("strict-transport-security"),
        "max-age=31536000; includeSubDomains; preload",
      );
      assert.equal(res.headers.get("content-security-policy"), "default-src 'self'");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      // referrerPolicy: false omits the header.
      assert.equal(res.headers.get("referrer-policy"), null);
      await res.body?.cancel();
    } finally {
      server.close();
    }
  });
});
