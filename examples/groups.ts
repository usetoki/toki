// run: node examples/groups.ts
import assert from "node:assert/strict";
import { createApp } from "../ts/index.ts";

const app = createApp({ logger: false });

app.get("/health", () => "ok");

app.group("/api/v1", (g) => {
  g.use((req) => {
    req.setResponseHeader("x-api-version", "1");
  });
  g.get("/users", () => [{ id: 1, name: "ada" }]);
  g.get("/users/:id", (req) => ({ id: Number(req.params.id), name: "ada" }));
});

const health = await app.inject({ url: "/health" });
assert.equal(health.statusCode, 200);
assert.equal(health.headers["x-api-version"], undefined);

const users = await app.inject({ url: "/api/v1/users" });
assert.equal(users.statusCode, 200);
assert.equal(users.headers["x-api-version"], "1");
assert.deepEqual(users.json(), [{ id: 1, name: "ada" }]);

const user = await app.inject({ url: "/api/v1/users/7" });
assert.equal(user.statusCode, 200);
assert.equal(user.headers["x-api-version"], "1");
assert.deepEqual(user.json(), { id: 7, name: "ada" });

console.log("groups: ok");
process.exit(0);
