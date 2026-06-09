import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { helmet } from "../src/index.ts";

const app = createApp({ logger: false });

app.register(
  (s) => {
    s.use(helmet());
    s.get("/x", () => reply.text("ok"));
    s.get("/boom", () => {
      throw new Error("kaboom");
    });
  },
  { prefix: "/default" },
);

app.register(
  (s) => {
    s.use(
      helmet({
        contentSecurityPolicy: false,
        hsts: { maxAge: 60, preload: true },
        frameguard: "DENY",
        crossOriginEmbedderPolicy: true,
        referrerPolicy: "strict-origin-when-cross-origin",
      }),
    );
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/custom" },
);

app.register(
  (s) => {
    s.use(
      helmet({
        contentSecurityPolicy: { directives: { scriptSrc: ["'self'", "https://cdn.example"] } },
      }),
    );
    s.get("/x", () => reply.text("ok"));
  },
  { prefix: "/csp" },
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("defaults set the full hardening header set", async () => {
  const r = await app.inject({ url: "/default/x" });
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(r.headers["origin-agent-cluster"], "?1");
  assert.equal(r.headers["x-dns-prefetch-control"], "off");
  assert.equal(r.headers["x-download-options"], "noopen");
  assert.equal(r.headers["x-permitted-cross-domain-policies"], "none");
  assert.equal(r.headers["x-xss-protection"], "0");
  assert.equal(r.headers["strict-transport-security"], "max-age=15552000; includeSubDomains");
  assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/);
});

test("headers ride along on an error response", async () => {
  const r = await app.inject({ url: "/default/boom" });
  assert.equal(r.statusCode, 500);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/);
});

test("csp:false drops it; hsts + coep customizable", async () => {
  const r = await app.inject({ url: "/custom/x" });
  assert.equal(r.headers["content-security-policy"], undefined);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(r.headers["cross-origin-embedder-policy"], "require-corp");
  assert.equal(r.headers["strict-transport-security"], "max-age=60; includeSubDomains; preload");
});

test("csp directives merge over the defaults", async () => {
  const r = await app.inject({ url: "/csp/x" });
  const csp = String(r.headers["content-security-policy"]);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.example/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
});

test("an invalid HSTS maxAge is rejected at construction", () => {
  assert.throws(() => helmet({ hsts: { maxAge: Number.NaN } }), /maxAge/);
  assert.throws(() => helmet({ hsts: { maxAge: -1 } }), /maxAge/);
});
