import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import {
  assert as httpAssert,
  createError,
  httpErrors,
  isHttpError,
  sensible,
} from "../dist/index.js";

const seen: unknown[] = [];
const app = createApp({ logger: false });
sensible(app, { onError: (e) => seen.push(e), type: (s) => `https://errors.test/${s}` });

app.get("/nf", () => {
  throw httpErrors.notFound("no such user");
});
app.get("/boom", () => {
  throw httpErrors.internalServerError("db password is hunter2");
});
app.get("/plain", () => {
  throw new Error("raw internal detail");
});
app.get("/rate", () => {
  throw createError(429, "slow down", { headers: { "Retry-After": "5" } });
});
app.get("/invalid", () => {
  throw createError(422, "validation failed", { details: { errors: ["email is required"] } });
});
app.get("/check/:id", (req) => {
  httpAssert(req.params.id === "ok", 400, "bad id");
  return reply.text("passed");
});

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

type Res = Awaited<ReturnType<typeof app.inject>>;
type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
} & Record<string, unknown>;
const problem = (res: Res): Problem => res.json() as Problem;

test("a thrown httpError renders RFC 9457 problem+json", async () => {
  const res = await app.inject({ url: "/nf" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["content-type"], "application/problem+json; charset=utf-8");
  assert.deepEqual(problem(res), {
    type: "https://errors.test/404",
    title: "Not Found",
    status: 404,
    detail: "no such user",
    instance: "/nf",
  });
});

test("5xx errors hide their message", async () => {
  const res = await app.inject({ url: "/boom" });
  assert.equal(res.statusCode, 500);
  assert.equal(problem(res).detail, "Internal Server Error");
  assert.ok(!res.body.includes("hunter2"));
  assert.equal(seen.length > 0, true); // onError fired for the 5xx
});

test("an unknown thrown value becomes a 500 with no leaked detail", async () => {
  const res = await app.inject({ url: "/plain" });
  assert.equal(res.statusCode, 500);
  assert.equal(problem(res).detail, "Internal Server Error");
  assert.ok(!res.body.includes("raw internal detail"));
});

test("error headers reach the response", async () => {
  const res = await app.inject({ url: "/rate" });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "5");
  assert.equal(problem(res).detail, "slow down");
});

test("4xx details become problem extension members", async () => {
  const res = await app.inject({ url: "/invalid" });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(problem(res).errors, ["email is required"]);
  assert.equal(problem(res).detail, "validation failed");
});

test("assert throws on a falsy condition and passes otherwise", async () => {
  assert.equal((await app.inject({ url: "/check/ok" })).statusCode, 200);
  const bad = await app.inject({ url: "/check/nope" });
  assert.equal(bad.statusCode, 400);
  assert.equal(problem(bad).detail, "bad id");
});

test("isHttpError recognizes HttpError and status-bearing objects", () => {
  assert.ok(isHttpError(httpErrors.conflict()));
  assert.ok(isHttpError({ statusCode: 418, message: "teapot" }));
  assert.ok(!isHttpError(new Error("plain")));
  assert.ok(!isHttpError("nope"));
});

test("httpErrors expose status and reason", () => {
  const e = httpErrors.unprocessableEntity("bad");
  assert.equal(e.statusCode, 422);
  assert.equal(e.title, "Unprocessable Entity");
  assert.equal(e.expose, true);
  assert.equal(httpErrors.badGateway().expose, false);
});
