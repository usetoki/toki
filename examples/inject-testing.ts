// run: node examples/inject-testing.ts
import assert from "node:assert/strict";
import { createApp, reply } from "../dist/index.js";

const app = createApp({ logger: false });

app.get("/ping", () => "pong");
app.post("/echo", async (req) => reply.json(await req.json(), 201));

async function main() {
  const ping = await app.inject("/ping");
  assert.equal(ping.statusCode, 200);
  assert.equal(ping.body, "pong");

  const echo = await app.inject({ method: "POST", url: "/echo", payload: { name: "ada" } });
  assert.equal(echo.statusCode, 201);
  assert.deepEqual(echo.json(), { name: "ada" });

  console.log("inject-testing example OK");
  process.exit(0);
}

main();
