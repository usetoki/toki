import type { DocPage } from "../../types";

export const streamingPage: DocPage = {
  slug: "streaming",
  title: "Streaming",
  description: "Chunked responses and server-sent events with native backpressure.",
  blocks: [
    {
      kind: "paragraph",
      text: "`reply.stream(source, options)` writes a response with `Transfer-Encoding: chunked`. The source is an async (or sync) iterable or a Node `Readable`, anything you can `for await ... of`. Each chunk, bytes or a UTF-8 string, is written as it arrives, so the client starts receiving before the whole body exists. Use it for large or slow bodies: a file you do not want to buffer, output generated on the fly, or an open-ended event stream.",
    },
    { kind: "heading", id: "basics", text: "Generated chunks" },
    {
      kind: "paragraph",
      text: 'Return `reply.stream` straight from a handler. A string chunk is UTF-8 encoded; a `Uint8Array` goes out verbatim. Empty chunks are skipped, so yielding `""` to keep a generator alive costs nothing on the wire.',
    },
    {
      kind: "code",
      snippet: {
        filename: "numbers.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp();

app.get("/numbers", () => reply.stream(count(), { contentType: "text/plain" }));

async function* count() {
  for (let n = 1; n <= 5; n++) {
    yield \`\${n}\\n\`;
    await new Promise((r) => setTimeout(r, 250)); // one line every 250ms
  }
}

app.listen(3000);`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        ["`status`", "`200`", "Response status code."],
        [
          "`contentType`",
          '`"application/octet-stream"`',
          'The `Content-Type` header. Set `"text/event-stream"` for SSE, `"text/plain"` for text.',
        ],
        [
          "`headers`",
          "`[]`",
          "Extra response headers as `[name, value]` pairs (e.g. `Content-Disposition`).",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "A streaming response bypasses response hooks and JSON serialization: there is no materialized body to transform. That means the [compression](/docs/compression) hook does not see a stream; if you want compressed chunks, compress inside the source. The engine still adds the status line, `Transfer-Encoding`, and `Connection`.",
    },
    { kind: "heading", id: "file", text: "Streaming a file" },
    {
      kind: "paragraph",
      text: "A Node `Readable` is an async iterable, so a file stream drops straight in. The file is read in chunks and pushed to the socket as it goes, so memory stays flat no matter how large the file. For serving a directory of assets, prefer [static files](/docs/static-files), which reads once and serves natively; reach for a stream when the path is computed per request or the bytes come from elsewhere.",
    },
    {
      kind: "code",
      snippet: {
        filename: "download.ts",
        language: "ts",
        code: `import { createReadStream } from "node:fs";

app.get("/report.csv", () =>
  reply.stream(createReadStream("./reports/latest.csv"), {
    contentType: "text/csv",
    headers: [["Content-Disposition", "attachment; filename=\\"report.csv\\""]],
  }),
);`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Want `Range` requests, `206 Partial Content`, and resumable downloads from a handler-controlled source? Use the [Range plugin](/docs/plugin-range) instead — a bare stream always sends the whole body from the start.",
    },
    { kind: "heading", id: "transform", text: "Transforming a source" },
    {
      kind: "paragraph",
      text: "Because the source is just an async iterable, you can wrap one generator around another — pull rows from a database cursor, format each as a line, and stream the result without ever holding the full set in memory.",
    },
    {
      kind: "code",
      snippet: {
        filename: "export.ts",
        language: "ts",
        code: `app.get("/export.ndjson", () => reply.stream(rows(), { contentType: "application/x-ndjson" }));

async function* rows() {
  // db.cursor() yields one record at a time
  for await (const record of db.cursor("SELECT * FROM events")) {
    yield \`\${JSON.stringify(record)}\\n\`;
  }
}`,
      },
    },
    { kind: "heading", id: "sse", text: "Server-sent events" },
    {
      kind: "paragraph",
      text: 'Set `contentType: "text/event-stream"` and yield SSE-formatted strings: `data:` lines, an optional `event:` and `id:`, a blank line between events. The browser\'s `EventSource` reads them and reconnects on its own.',
    },
    {
      kind: "code",
      snippet: {
        filename: "sse.ts",
        language: "ts",
        code: `app.get("/events", () =>
  reply.stream(ticker(), { contentType: "text/event-stream" }),
);

async function* ticker() {
  for (let n = 0; ; n++) {
    yield \`event: tick\\ndata: \${JSON.stringify({ n })}\\n\\n\`;
    await new Promise((r) => setTimeout(r, 1000));
  }
}`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "This is hand-rolled SSE, fine for a simple stream. For heartbeats that stop proxies idling the connection, `id:` tracking, and `Last-Event-ID` resume after a drop, use the [SSE plugin](/docs/plugin-sse). It gives you a `stream.send` handle and an abort `signal` instead of a raw generator.",
    },
    { kind: "heading", id: "backpressure", text: "Backpressure and ending" },
    {
      kind: "paragraph",
      text: "Backpressure is native and automatic. Each chunk reports the connection's write backlog; once it passes 1 MiB, toki pauses the producer (it stops pulling from your iterator) until the socket drains. A slow client throttles your generator instead of blowing up memory, and you write nothing special.",
    },
    {
      kind: "list",
      items: [
        "The stream ends when the source is exhausted (the generator returns or the `Readable` finishes). toki sends the terminating chunk and closes the response.",
        "If the client disconnects mid-stream, the next write reports the connection is gone and toki stops pulling — your generator is abandoned, so release resources in a `finally` block.",
        "A throw inside the source is logged and ends the response cleanly; it never becomes an unhandled rejection.",
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "cleanup.ts",
        language: "ts",
        code: `async function* tail(path: string) {
  const handle = await open(path); // node:fs/promises
  try {
    for await (const line of follow(handle)) {
      yield \`\${line}\\n\`;
    }
  } finally {
    await handle.close(); // runs whether the client left or the source ended
  }
}`,
      },
    },
  ],
};
