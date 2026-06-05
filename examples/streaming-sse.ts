// run: node examples/streaming-sse.ts
import assert from "node:assert/strict";
import { createApp, reply } from "../dist/index.js";

const app = createApp({ logger: false });

app.get("/clock", () => {
  async function* ticks() {
    for (let i = 1; i <= 3; i++) {
      yield `event: tick\ndata: ${i}\n\n`;
    }
  }
  return reply.stream(ticks(), { contentType: "text/event-stream" });
});

const res = await app.inject({ url: "/clock" });
assert.equal(res.statusCode, 200);
assert.equal(res.headers["content-type"], "text/event-stream");
assert.equal(res.body, "event: tick\ndata: 1\n\nevent: tick\ndata: 2\n\nevent: tick\ndata: 3\n\n");

console.log("streaming-sse ok");
process.exit(0);
