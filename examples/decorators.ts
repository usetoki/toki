// run: node examples/decorators.ts
import assert from "node:assert";
import { createApp } from "../dist/index.js";

const app = createApp();

app.decorate("db", { users: { 1: "ada" } });

app.decorateRequest("requestedAt", null);

app.addHook("onRequest", (req) => {
  (req as unknown as { requestedAt: number | null }).requestedAt = Date.now();
});

app.get("/users/:id", (req) => {
  const db = (app as unknown as { db: { users: Record<string, string | undefined> } }).db;
  const id = req.params.id ?? "";
  const name = db.users[id] ?? null;
  return { name, requestedAt: (req as unknown as { requestedAt: number | null }).requestedAt };
});

const res = await app.inject({ method: "GET", url: "/users/1" });
assert.equal(res.statusCode, 200);
const body = res.json<{ name: string | null; requestedAt: number | null }>();
assert.equal(body.name, "ada");
assert.equal(typeof body.requestedAt, "number");

console.log("decorators ok:", JSON.stringify(body));
process.exit(0);
