import type { DocPage } from "../../types";

export const streamingPage: DocPage = {
  slug: "streaming",
  title: "Streaming",
  description: "Chunked responses and server-sent events with native backpressure.",
  blocks: [
    {
      kind: "paragraph",
      text: "`reply.stream(source, options)` writes a response with `Transfer-Encoding: chunked`. The source is an async (or sync) iterable or a Node `Readable`; each chunk — bytes or a UTF-8 string — is written as it arrives.",
    },
    {
      kind: "code",
      snippet: {
        filename: "stream.ts",
        language: "ts",
        code: `app.get("/numbers", () =>
  reply.stream(count(), { contentType: "text/plain" }),
);

async function* count() {
  for (let n = 1; n <= 5; n++) {
    yield n + "\\n";
    await new Promise((r) => setTimeout(r, 250));
  }
}`,
      },
    },
    { kind: "heading", id: "sse", text: "Server-sent events" },
    {
      kind: "paragraph",
      text: "Set `contentType: \"text/event-stream\"` and yield SSE-formatted strings.",
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
    yield "data: " + JSON.stringify({ n }) + "\\n\\n";
    await new Promise((r) => setTimeout(r, 1000));
  }
}`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "Backpressure is native: when the connection's write backlog grows, toki pauses the producer until the socket drains, so a slow client can't blow up memory.",
    },
  ],
};
