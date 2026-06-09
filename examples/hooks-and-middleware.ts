// run: node examples/hooks-and-middleware.ts

import assert from "node:assert/strict";
import { createApp, reply } from "../ts/index.ts";

const app = createApp();
const phases: string[] = [];

app.use((req) => {
  req.setResponseHeader("x-powered-by", "toki");
});

app.addHook("onRequest", (_req) => {
  phases.push("onRequest");
});
app.addHook("preParsing", (_req) => {
  phases.push("preParsing");
});
app.addHook("preValidation", (_req) => {
  phases.push("preValidation");
});

app.addHook("preHandler", (req) => {
  phases.push("preHandler");
  if (req.headers.get("authorization") !== "Bearer secret") {
    return reply.json({ error: "unauthorized" }, 401);
  }
});

app.addHook("preSerialization", (_req, payload) => {
  phases.push("preSerialization");
  return { ...(payload as Record<string, unknown>), stamped: true };
});

app.addHook("onResponse", (_req, _res) => {
  phases.push("onResponse");
});

app.addHook("onSend", (req, _res) => {
  phases.push("onSend");
  req.appendResponseHeader("x-pipeline", phases.join(","));
});

app.get("/profile", (_req) => ({ user: "ada" }));

const ok = await app.inject({
  method: "GET",
  url: "/profile",
  headers: { authorization: "Bearer secret" },
});
assert.equal(ok.statusCode, 200);
assert.deepEqual(ok.json(), { user: "ada", stamped: true });
assert.equal(ok.headers["x-powered-by"], "toki");
assert.deepEqual(phases, [
  "onRequest",
  "preParsing",
  "preValidation",
  "preHandler",
  "preSerialization",
  "onResponse",
  "onSend",
]);
assert.equal(ok.headers["x-pipeline"], phases.join(","));

phases.length = 0;
const denied = await app.inject({ method: "GET", url: "/profile" });
assert.equal(denied.statusCode, 401);
assert.deepEqual(denied.json(), { error: "unauthorized" });
assert.equal(denied.headers["x-powered-by"], "toki");
assert.deepEqual(phases, [
  "onRequest",
  "preParsing",
  "preValidation",
  "preHandler",
  "onResponse",
  "onSend",
]);

console.log("hooks-and-middleware: pipeline order + auth short-circuit verified");
process.exit(0);
