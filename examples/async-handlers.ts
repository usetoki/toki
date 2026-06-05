// run: node examples/async-handlers.ts
import assert from "node:assert/strict";
import { createApp, reply } from "../dist/index.js";

const app = createApp({ logger: false });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.get("/user/:id", async (req) => {
  await sleep(10);
  return { id: req.params.id, name: "Ada" };
});

app.get("/report", async () => {
  const total = await sleep(10).then(() => 42);
  return reply.json({ total }, 201);
});

const user = await app.inject({ url: "/user/7" });
assert.equal(user.statusCode, 200);
assert.deepEqual(user.json(), { id: "7", name: "Ada" });

const report = await app.inject({ url: "/report" });
assert.equal(report.statusCode, 201);
assert.deepEqual(report.json(), { total: 42 });

console.log("async-handlers ok");
process.exit(0);
