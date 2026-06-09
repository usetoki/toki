// run: node examples/error-and-not-found.ts
import assert from "node:assert/strict";
import { createApp, reply } from "../ts/index.ts";

const app = createApp({ logger: false });

app.get("/boom", () => {
  throw new Error("kaboom");
});

app.get("/ok", () => ({ ok: true }));

app.setErrorHandler((req, err) => {
  const message = err instanceof Error ? err.message : "unknown";
  return reply.json({ error: "Internal Server Error", message, path: req.path }, 500);
});

app.setNotFoundHandler((req) =>
  reply.json({ error: "Not Found", method: req.method, path: req.path }, 404),
);

const ok = await app.inject({ method: "GET", url: "/ok" });
assert.equal(ok.statusCode, 200);
assert.deepEqual(ok.json(), { ok: true });

const boom = await app.inject({ method: "GET", url: "/boom" });
assert.equal(boom.statusCode, 500);
assert.deepEqual(boom.json(), { error: "Internal Server Error", message: "kaboom", path: "/boom" });

const missing = await app.inject({ method: "GET", url: "/nope" });
assert.equal(missing.statusCode, 404);
assert.deepEqual(missing.json(), { error: "Not Found", method: "GET", path: "/nope" });

console.log("error-and-not-found example ok");
process.exit(0);
