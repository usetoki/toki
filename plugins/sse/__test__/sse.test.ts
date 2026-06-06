import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp } from "@usetoki/toki";
import { sse } from "../dist/index.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const app = createApp({ logger: false });

app.get("/basic", (req) =>
  sse(
    req,
    (s) => {
      s.send("hi");
      s.send({ id: "5", event: "tick", data: "1" });
      s.send({ data: { a: 1 } });
      s.close();
    },
    { heartbeatMs: 0 },
  ),
);
app.get("/multiline", (req) =>
  sse(
    req,
    (s) => {
      s.send({ data: "line1\nline2" });
      s.close();
    },
    { heartbeatMs: 0 },
  ),
);
app.get("/resume", (req) =>
  sse(
    req,
    (s) => {
      s.send({ data: s.lastEventId ?? "none" });
      s.close();
    },
    { heartbeatMs: 0 },
  ),
);
app.get("/inject", (req) =>
  sse(
    req,
    (s) => {
      s.send({ id: "1\n2", event: "a\nb", data: "ok" });
      s.close();
    },
    { heartbeatMs: 0 },
  ),
);
app.get("/heartbeat", (req) =>
  sse(
    req,
    async (s) => {
      await sleep(70);
      s.close();
    },
    { heartbeatMs: 20 },
  ),
);

const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("streams events in the text/event-stream format", async () => {
  const res = await app.inject({ url: "/basic" });
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.match(res.body, /data: hi\n\n/);
  assert.match(res.body, /id: 5\nevent: tick\ndata: 1\n\n/);
  assert.match(res.body, /data: \{"a":1\}\n\n/);
});

test("multi-line data becomes multiple data: lines", async () => {
  const res = await app.inject({ url: "/multiline" });
  assert.match(res.body, /data: line1\ndata: line2\n\n/);
});

test("Last-Event-ID is exposed for resume", async () => {
  const withId = await app.inject({ url: "/resume", headers: { "last-event-id": "99" } });
  assert.match(withId.body, /data: 99\n\n/);
  const without = await app.inject({ url: "/resume" });
  assert.match(without.body, /data: none\n\n/);
});

test("a heartbeat keeps the stream alive", async () => {
  const res = await app.inject({ url: "/heartbeat" });
  assert.match(res.body, /:\n\n/); // at least one heartbeat comment
});

test("newlines in id/event are stripped so a value can't inject frames", async () => {
  const res = await app.inject({ url: "/inject" });
  assert.match(res.body, /id: 12\n/); // "1\n2" collapsed to "12"
  assert.match(res.body, /event: ab\n/);
  assert.doesNotMatch(res.body, /id: 1\n2/);
});
