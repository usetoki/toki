// run: node examples/routing.ts
import assert from "node:assert/strict";
import { createApp, reply } from "../ts/index.ts";

const app = createApp();

app.get("/users/:id", (req) => reply.json({ id: req.params.id }));
app.post("/users", (req) => reply.json(req.json(), 201));
app.put("/users/:id", (req) => reply.json({ id: req.params.id, ...req.json<object>() }));
app.patch("/users/:id", (req) => reply.json({ id: req.params.id, patched: req.json() }));
app.delete("/users/:id", () => reply.empty());

app.get("/files/*", (req) => reply.text(req.params["*"] ?? ""));

app.route("GET", "/health", () => "ok");

async function main() {
  let res = await app.inject("/users/42");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id: "42" });

  res = await app.inject({ method: "POST", url: "/users", payload: { name: "ada" } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { name: "ada" });

  res = await app.inject({ method: "PUT", url: "/users/7", payload: { name: "grace" } });
  assert.deepEqual(res.json(), { id: "7", name: "grace" });

  res = await app.inject({ method: "PATCH", url: "/users/7", payload: { name: "linus" } });
  assert.deepEqual(res.json(), { id: "7", patched: { name: "linus" } });

  res = await app.inject({ method: "DELETE", url: "/users/7" });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, "");

  res = await app.inject("/files/docs/intro.md");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "docs/intro.md");

  res = await app.inject("/health");
  assert.equal(res.body, "ok");

  res = await app.inject("/nope");
  assert.equal(res.statusCode, 404);

  console.log("routing example OK");
  process.exit(0);
}

main();
