import type { DocPage } from "../../types";

export const ssePluginPage: DocPage = {
  slug: "plugin-sse",
  title: "Server-Sent Events",
  description: "SSE streams with heartbeats, event ids, and Last-Event-ID resume.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-sse` opens a `text/event-stream` from a handler — a one-way push channel to the browser over a plain HTTP connection. You get a stream handle to `send` events, a heartbeat that stops proxies idling the connection, the client's `Last-Event-ID` for resuming after a drop, and a `signal` that aborts the moment the client disconnects. Reach for it over WebSockets when you only push (live prices, build logs, notifications) — `EventSource` reconnects on its own.",
    },
    {
      kind: "code",
      snippet: { filename: "install.sh", language: "bash", code: `npm install @usetoki/toki-sse` },
    },
    {
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "Return `sse(req, producer)` from the handler. The producer runs until it returns or the client leaves; whatever you `send` is serialized into the wire format and flushed as it arrives.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { sse } from "@usetoki/toki-sse";

const app = createApp();

app.get("/clock", (req) =>
  sse(req, async (stream) => {
    while (!stream.signal.aborted) {
      stream.send({ event: "tick", data: { now: Date.now() } });
      await sleep(1000);
    }
  }),
);`,
      },
    },
    {
      kind: "heading",
      id: "resume",
      text: "Resuming with Last-Event-ID",
    },
    {
      kind: "paragraph",
      text: "Give each event an `id` and the browser stores it. On reconnect, `EventSource` resends the last id as the `Last-Event-ID` header, which arrives as `stream.lastEventId` — replay from there and the client never misses a beat across a flaky network.",
    },
    {
      kind: "code",
      snippet: {
        filename: "prices.ts",
        language: "ts",
        code: `app.get("/prices", (req) =>
  sse(req, async (stream) => {
    // null on the first connect; the last delivered id after a reconnect
    for await (const tick of priceFeed({ since: stream.lastEventId })) {
      if (stream.signal.aborted) break; // client went away — stop producing
      stream.send({ id: tick.seq, event: "price", data: tick });
    }
  }),
);`,
      },
    },
    {
      kind: "heading",
      id: "comments-and-retry",
      text: "Comments and reconnect hints",
    },
    {
      kind: "paragraph",
      text: "`stream.comment(text)` writes a `: …` line — a manual keep-alive or marker the client ignores. `retry` on an event sets how long (ms) the browser waits before reconnecting. CR, LF, and NUL are stripped from `id`, `event`, `comment`, and `retry` so a value can't inject extra frames; multi-line `data` is split across `data:` lines correctly.",
    },
    {
      kind: "code",
      snippet: {
        filename: "logs.ts",
        language: "ts",
        code: `app.get("/build/:id/logs", (req) =>
  sse(req, async (stream) => {
    stream.comment("attached"); // first byte flushes headers
    stream.send({ retry: 5000, data: "reconnect in 5s if I drop" });
    for await (const line of tailBuild(req.params.id)) {
      if (stream.signal.aborted) break;
      stream.send(line); // a bare string -> { data: line }
    }
    stream.close(); // end the stream when the build finishes
  }),
);`,
      },
    },
    {
      kind: "heading",
      id: "browser",
      text: "Consuming it in the browser",
    },
    {
      kind: "code",
      snippet: {
        filename: "client.ts",
        language: "ts",
        code: `const es = new EventSource("/prices");
es.addEventListener("price", (e) => {
  const tick = JSON.parse(e.data);
  render(tick);
});
// EventSource reconnects on its own and resends Last-Event-ID`,
      },
    },
    {
      kind: "heading",
      id: "send-shape",
      text: "Event shape",
    },
    {
      kind: "paragraph",
      text: "`stream.send(event)` takes an `SseEvent` object, or a bare string as shorthand for `{ data }`. An object `data` is JSON-encoded; a string is sent as-is.",
    },
    {
      kind: "table",
      headers: ["Field", "Type", "Notes"],
      rows: [
        ["`data`", "`string \\| object`", "Required. An object is JSON-encoded."],
        ["`event`", "`string`", "Event name the client listens for via `addEventListener`."],
        ["`id`", "`string`", "Echoed to the client, resent as `Last-Event-ID` on reconnect."],
        ["`retry`", "`number`", "Reconnect delay hint in ms. Must be a non-negative integer or it's dropped."],
      ],
    },
    {
      kind: "heading",
      id: "options",
      text: "Options",
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Notes"],
      rows: [
        [
          "`heartbeatMs`",
          "`number`",
          "`15000`",
          "Interval between keep-alive comments. `0` disables it. Cleared automatically when the stream ends.",
        ],
        [
          "`headers`",
          "`ReadonlyArray<[string, string]>`",
          "`[]`",
          "Extra response headers, merged after `Cache-Control: no-cache`.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The stream buffers up to 1024 events if the consumer falls behind, then drops the oldest. A producer that pushes faster than the client drains will silently lose old events — pace the producer or rely on `Last-Event-ID` to backfill.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Always check `stream.signal.aborted` (or `break` on it) inside your loop. Without it a producer keeps running after the client disconnects, holding the upstream feed open for nothing.",
    },
  ],
};
