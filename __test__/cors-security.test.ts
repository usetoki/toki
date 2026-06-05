import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply, securityHeaders, corsHeaders, corsPreflight } from "../dist/index.js";

const app = createApp({ logger: false });

app.register(
  (s) => {
    s.cors({ origin: ["https://app.example"], credentials: true, maxAge: 600 });
    s.use(securityHeaders({ hsts: true, csp: "default-src 'self'" }));
    s.get("/data", () => reply.json({ ok: true }));
    s.post("/data", () => reply.json({ created: true }, 201));
    s.get("/boom", () => {
      throw new Error("kaboom");
    });
  },
  { prefix: "/m7" },
);

app.register(
  (s) => {
    s.cors({ origin: "*" });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/wild" },
);

app.register(
  (s) => {
    s.cors();
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/default" },
);

app.register(
  (s) => {
    s.cors({ origin: "https://only.example" });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/fixed" },
);

app.register(
  (s) => {
    s.cors({ origin: (o) => o.endsWith(".trusted.example") });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/pred" },
);

app.register(
  (s) => {
    s.cors({ origin: ["https://app.example", "http://localhost:5173"] });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/list" },
);

app.register(
  (s) => {
    s.cors({ origin: [] });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/none" },
);

app.register(
  (s) => {
    s.cors({ origin: ["https://app.example"] });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/nocred" },
);

app.register(
  (s) => {
    s.cors({ origin: "*", exposedHeaders: ["X-Total-Count", "X-Page"] });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/exposed" },
);

app.register(
  (s) => {
    s.cors({ origin: "*", exposedHeaders: [] });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/exposed-empty" },
);

app.register(
  (s) => {
    s.cors({ origin: "*", allowedHeaders: ["Content-Type", "Authorization"] });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/allowhdr" },
);

app.register(
  (s) => {
    s.cors({ origin: "*", methods: ["GET", "PUT", "DELETE"] });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/methods" },
);

app.register(
  (s) => {
    s.cors({ origin: "*" });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/nomax" },
);

app.register(
  (s) => {
    s.cors({ origin: "*", maxAge: 0 });
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/zeromax" },
);

app.register(
  (s) => {
    s.use(securityHeaders());
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/sec-default" },
);

app.register(
  (s) => {
    s.use(securityHeaders({ frameOptions: "SAMEORIGIN", referrerPolicy: "strict-origin" }));
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/sec-override" },
);

app.register(
  (s) => {
    s.use(securityHeaders({ hsts: 60 }));
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/sec-hsts" },
);

const CUSTOM_CSP = "default-src 'none'; script-src 'self'; img-src https:";
app.register(
  (s) => {
    s.use(securityHeaders({ csp: CUSTOM_CSP }));
    s.get("/x", () => reply.text("ok"));
    s.get("/boom", () => {
      throw new Error("kaboom");
    });
  },
  { prefix: "/sec-csp" },
);

app.register(
  (s) => {
    s.use(corsHeaders({ origin: ["https://hand.example"], credentials: true }));
    s.get("/x", () => reply.text("ok"));
    s.options("/widget", corsPreflight({ origin: "*", methods: ["GET", "POST"], maxAge: 120 }));
  },
  { prefix: "/hand" },
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("CORS headers on an actual request from an allowed origin", async () => {
  const r = await app.inject({ url: "/m7/data", headers: { Origin: "https://app.example" } });
  assert.equal(r.headers["access-control-allow-origin"], "https://app.example");
  assert.equal(r.headers["access-control-allow-credentials"], "true");
  assert.match(String(r.headers["vary"] ?? ""), /Origin/);
});

test("disallowed origin gets no allow-origin header", async () => {
  const r = await app.inject({ url: "/m7/data", headers: { Origin: "https://evil.example" } });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("preflight OPTIONS is answered with 204 and the negotiated headers", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/m7/data",
    headers: {
      Origin: "https://app.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, x-token",
    },
  });
  assert.equal(r.statusCode, 204);
  assert.match(String(r.headers["access-control-allow-methods"] ?? ""), /POST|GET/);
  assert.equal(r.headers["access-control-allow-headers"], "content-type, x-token");
  assert.equal(r.headers["access-control-max-age"], "600");
});

test("security headers are present on responses", async () => {
  const r = await app.inject({ url: "/m7/data" });
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.match(String(r.headers["strict-transport-security"] ?? ""), /max-age=\d+/);
  assert.equal(r.headers["content-security-policy"], "default-src 'self'");
});

test("a request with no Origin header gets no allow-origin under an allowlist", async () => {
  const r = await app.inject({ url: "/m7/data" });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("an empty Origin header is treated as a present-but-unlisted origin", async () => {
  const r = await app.inject({ url: "/m7/data", headers: { Origin: "" } });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("reflected allowed origin appends Vary: Origin so caches key on it", async () => {
  const r = await app.inject({ url: "/m7/data", headers: { Origin: "https://app.example" } });
  const vary = String(r.headers["vary"] ?? "");
  assert.ok(
    vary
      .split(",")
      .map((s) => s.trim())
      .includes("Origin"),
  );
});

test("wildcard origin echoes * and omits Vary", async () => {
  const r = await app.inject({ url: "/wild/x", headers: { Origin: "https://anything.example" } });
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(r.headers["vary"], undefined);
});

test("wildcard origin answers even when no Origin header is sent", async () => {
  const r = await app.inject({ url: "/wild/x" });
  assert.equal(r.headers["access-control-allow-origin"], "*");
});

test("default cors() (no options) behaves as wildcard", async () => {
  const r = await app.inject({
    url: "/default/x",
    headers: { Origin: "https://whatever.example" },
  });
  assert.equal(r.headers["access-control-allow-origin"], "*");
});

test("a fixed string origin is returned verbatim, even for a mismatched request origin", async () => {
  const r = await app.inject({ url: "/fixed/x", headers: { Origin: "https://other.example" } });
  assert.equal(r.headers["access-control-allow-origin"], "https://only.example");
  assert.match(String(r.headers["vary"] ?? ""), /Origin/);
});

test("a predicate origin reflects only when it returns true", async () => {
  const ok = await app.inject({ url: "/pred/x", headers: { Origin: "https://a.trusted.example" } });
  assert.equal(ok.headers["access-control-allow-origin"], "https://a.trusted.example");

  const no = await app.inject({ url: "/pred/x", headers: { Origin: "https://a.evil.example" } });
  assert.equal(no.headers["access-control-allow-origin"], undefined);
});

test("array allowlist matches exactly — scheme, host and port all count", async () => {
  const dev = await app.inject({ url: "/list/x", headers: { Origin: "http://localhost:5173" } });
  assert.equal(dev.headers["access-control-allow-origin"], "http://localhost:5173");

  const wrongScheme = await app.inject({
    url: "/list/x",
    headers: { Origin: "http://app.example" },
  });
  assert.equal(wrongScheme.headers["access-control-allow-origin"], undefined);

  const wrongPort = await app.inject({
    url: "/list/x",
    headers: { Origin: "http://localhost:3000" },
  });
  assert.equal(wrongPort.headers["access-control-allow-origin"], undefined);
});

test("an empty array allowlist rejects every origin", async () => {
  const r = await app.inject({ url: "/none/x", headers: { Origin: "https://app.example" } });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("credentials header is set only alongside an allowed origin", async () => {
  const allowed = await app.inject({ url: "/m7/data", headers: { Origin: "https://app.example" } });
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");
  const rejected = await app.inject({
    url: "/m7/data",
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

test("credentials false omits the allow-credentials header", async () => {
  const r = await app.inject({ url: "/nocred/x", headers: { Origin: "https://app.example" } });
  assert.equal(r.headers["access-control-allow-origin"], "https://app.example");
  assert.equal(r.headers["access-control-allow-credentials"], undefined);
});

test("exposedHeaders are advertised on actual responses", async () => {
  const r = await app.inject({ url: "/exposed/x", headers: { Origin: "https://app.example" } });
  assert.equal(r.headers["access-control-expose-headers"], "X-Total-Count, X-Page");
});

test("an empty exposedHeaders list emits no expose-headers header", async () => {
  const r = await app.inject({
    url: "/exposed-empty/x",
    headers: { Origin: "https://app.example" },
  });
  assert.equal(r.headers["access-control-expose-headers"], undefined);
});

test("preflight reflects requested headers verbatim when allowedHeaders is unset", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/m7/data",
    headers: {
      Origin: "https://app.example",
      "Access-Control-Request-Headers": "Authorization, X-Custom",
    },
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers["access-control-allow-headers"], "Authorization, X-Custom");
});

test("preflight with no requested-headers and no config falls back to *", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/m7/data",
    headers: { Origin: "https://app.example" },
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers["access-control-allow-headers"], "*");
});

test("a fixed allowedHeaders config overrides the reflected request headers", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/allowhdr/x",
    headers: { Origin: "https://app.example", "Access-Control-Request-Headers": "x-ignored" },
  });
  assert.equal(r.headers["access-control-allow-headers"], "Content-Type, Authorization");
});

test("preflight advertises the configured methods list", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/methods/x",
    headers: { Origin: "https://app.example" },
  });
  assert.equal(r.headers["access-control-allow-methods"], "GET, PUT, DELETE");
});

test("preflight without methods config advertises the default method set", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/m7/data",
    headers: { Origin: "https://app.example" },
  });
  const methods = String(r.headers["access-control-allow-methods"] ?? "");
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.ok(methods.includes(m), `expected default methods to include ${m}`);
  }
});

test("preflight omits Max-Age when maxAge is unset", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/nomax/x",
    headers: { Origin: "https://app.example" },
  });
  assert.equal(r.headers["access-control-max-age"], undefined);
});

test("maxAge of 0 is emitted (a valid disable-cache directive, not omitted)", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/zeromax/x",
    headers: { Origin: "https://app.example" },
  });
  assert.equal(r.headers["access-control-max-age"], "0");
});

test("preflight body is empty", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/m7/data",
    headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.body, "");
});

test("preflight from a rejected origin still answers 204 but withholds allow-origin", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/m7/data",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers["access-control-allow-origin"], undefined);
  assert.ok(r.headers["access-control-allow-methods"] !== undefined);
});

test("the catch-all preflight route answers OPTIONS on any path in scope", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/m7/some/deep/unrouted/path",
    headers: { Origin: "https://app.example", "Access-Control-Request-Method": "GET" },
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers["access-control-allow-origin"], "https://app.example");
});

test("the preflight handler also runs the corsHeaders middleware, so Vary is staged", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/m7/data",
    headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" },
  });
  assert.match(String(r.headers["vary"] ?? ""), /Origin/);
});

test("CORS headers are staged on a POST response", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/m7/data",
    headers: { Origin: "https://app.example" },
    payload: { hello: "world" },
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.headers["access-control-allow-origin"], "https://app.example");
  assert.equal(r.headers["access-control-allow-credentials"], "true");
});

test("securityHeaders defaults emit nosniff/DENY/no-referrer and skip hsts+csp", async () => {
  const r = await app.inject({ url: "/sec-default/x" });
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["strict-transport-security"], undefined);
  assert.equal(r.headers["content-security-policy"], undefined);
});

test("frameOptions and referrerPolicy overrides are honored", async () => {
  const r = await app.inject({ url: "/sec-override/x" });
  assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(r.headers["referrer-policy"], "strict-origin");
});

test("hsts: true yields the ~180-day max-age with includeSubDomains", async () => {
  const r = await app.inject({ url: "/m7/data" });
  assert.equal(r.headers["strict-transport-security"], "max-age=15552000; includeSubDomains");
});

test("a numeric hsts is used verbatim as max-age", async () => {
  const r = await app.inject({ url: "/sec-hsts/x" });
  assert.equal(r.headers["strict-transport-security"], "max-age=60; includeSubDomains");
});

test("a custom CSP string is passed through unchanged", async () => {
  const r = await app.inject({ url: "/sec-csp/x" });
  assert.equal(r.headers["content-security-policy"], CUSTOM_CSP);
});

test("security headers ride along on error and not-found responses", async () => {
  const err = await app.inject({ url: "/sec-csp/boom" });
  assert.equal(err.statusCode, 500);
  assert.equal(err.headers["x-content-type-options"], "nosniff");
  assert.equal(err.headers["content-security-policy"], CUSTOM_CSP);

  const rootErr = await app.inject({ url: "/m7/boom" });
  assert.equal(rootErr.statusCode, 500);
  assert.equal(rootErr.headers["x-content-type-options"], "nosniff");
  assert.equal(rootErr.headers["content-security-policy"], "default-src 'self'");
});

test("an allowed-origin request carries both the CORS and the security header sets", async () => {
  const r = await app.inject({ url: "/m7/data", headers: { Origin: "https://app.example" } });
  assert.equal(r.headers["access-control-allow-origin"], "https://app.example");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["content-security-policy"], "default-src 'self'");
  assert.equal(r.headers["strict-transport-security"], "max-age=15552000; includeSubDomains");
});

test("corsHeaders middleware can be wired by hand", async () => {
  const r = await app.inject({ url: "/hand/x", headers: { Origin: "https://hand.example" } });
  assert.equal(r.headers["access-control-allow-origin"], "https://hand.example");
  assert.equal(r.headers["access-control-allow-credentials"], "true");
});

test("corsPreflight handler can be mounted on a specific OPTIONS route", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: "/hand/widget",
    headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(r.headers["access-control-allow-methods"], "GET, POST");
  assert.equal(r.headers["access-control-max-age"], "120");
});
