import type { DocPage } from "../../types";

export const ssePluginPage: DocPage = {
  slug: "plugin-sse",
  title: "Server-Sent Events",
  description: "SSE streams with heartbeats, event ids, and Last-Event-ID resume.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-sse` opens a `text/event-stream` from a handler. You get a small stream handle to `send` events, a heartbeat that keeps proxies from idling the connection, the client's `Last-Event-ID` for resuming, and a `signal` that aborts when the client disconnects.",
    },
    {
      kind: "code",
      snippet: { filename: "install.sh", language: "bash", code: `npm install @usetoki/toki-sse` },
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { sse } from "@usetoki/toki-sse";

const app = createApp();

app.get("/prices", (req) =>
  sse(req, async (stream) => {
    // resume from where the client left off
    for await (const tick of priceFeed({ since: stream.lastEventId })) {
      if (stream.signal.aborted) break; // client went away
      stream.send({ id: tick.seq, event: "price", data: tick });
    }
  }),
);`,
      },
    },
    {
      kind: "list",
      items: [
        "`stream.send(event)` — `{ data, event?, id?, retry? }`, or a bare string for `{ data }`. Objects are JSON-encoded.",
        "`stream.lastEventId` — the client's `Last-Event-ID` header on reconnect, or `null`.",
        "`stream.signal` — an `AbortSignal` that fires on disconnect; stop producing on it.",
        "`heartbeatMs` (default 15000) sends a keep-alive comment; the heartbeat is cleared automatically when the stream ends.",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: 'On the browser, consume it with `new EventSource("/prices")` and `addEventListener("price", …)`. EventSource resends the last id as `Last-Event-ID` automatically.',
    },
  ],
};
