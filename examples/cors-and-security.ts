// run: node examples/cors-and-security.ts

import assert from "node:assert/strict";
import { createApp, securityHeaders } from "../ts/index.ts";

const app = createApp({ logger: false });

const allowed = new Set(["https://app.example.com"]);
app.cors({ origin: (o) => allowed.has(o), credentials: true, exposedHeaders: ["X-Request-Id"] });
app.use(securityHeaders({ hsts: true, csp: "default-src 'self'" }));

app.get("/me", (req) => ({ ip: req.ip }));

const preflight = await app.inject({
  method: "OPTIONS",
  url: "/me",
  headers: { origin: "https://app.example.com", "access-control-request-method": "GET" },
});
assert.equal(preflight.statusCode, 204);
assert.equal(preflight.headers["access-control-allow-origin"], "https://app.example.com");
assert.equal(preflight.headers["access-control-allow-credentials"], "true");
assert.match(String(preflight.headers["access-control-allow-methods"]), /GET/);

const res = await app.inject({ url: "/me", headers: { origin: "https://app.example.com" } });
assert.equal(res.statusCode, 200);
assert.equal(res.headers["access-control-allow-origin"], "https://app.example.com");
assert.equal(res.headers["access-control-expose-headers"], "X-Request-Id");
assert.equal(res.headers["x-content-type-options"], "nosniff");
assert.equal(res.headers["x-frame-options"], "DENY");
assert.equal(res.headers["referrer-policy"], "no-referrer");
assert.match(String(res.headers["strict-transport-security"]), /max-age=15552000/);
assert.equal(res.headers["content-security-policy"], "default-src 'self'");

const blocked = await app.inject({ url: "/me", headers: { origin: "https://evil.example" } });
assert.equal(blocked.statusCode, 200);
assert.equal(blocked.headers["access-control-allow-origin"], undefined);
assert.equal(blocked.headers["x-content-type-options"], "nosniff");

console.log("cors-and-security ok");
process.exit(0);
