import type { DocPage } from "../../types";

export const responsePage: DocPage = {
  slug: "response",
  title: "The response",
  description: "Building responses with reply, status codes, and headers.",
  blocks: [
    {
      kind: "paragraph",
      text: "Return a value from a handler and toki sends it. A `reply.*` builder gives explicit control over the body, status, and content type; a plain object is sent as JSON and a string as text.",
    },
    { kind: "heading", id: "reply", text: "The reply builders" },
    {
      kind: "table",
      headers: ["Call", "Result"],
      rows: [
        ["`reply.text(body, status?)`", "`text/plain` (default `200`)"],
        ["`reply.html(body, status?)`", "`text/html`"],
        ["`reply.json(data, status?)`", "`application/json`"],
        ["`reply.bytes(data, contentType?, status?)`", "Raw bytes (`application/octet-stream`)"],
        ["`reply.empty(status?)`", "No body (e.g. `204`)"],
        ["`reply.redirect(location, status?)`", "`Location` header (default `302`)"],
        ["`reply.stream(source, options)`", "Chunked stream — see [Streaming](/docs/streaming)"],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "responses.ts",
        language: "ts",
        code: `app.get("/text", () => reply.text("hello"));
app.get("/page", () => reply.html("<h1>hi</h1>"));
app.post("/users", (req) => reply.json({ id: 1 }, 201));
app.get("/blob", () => reply.bytes(new Uint8Array([1, 2, 3]), "image/png"));
app.get("/gone", () => reply.empty(204));
app.get("/old", () => reply.redirect("/new", 301));`,
      },
    },
    { kind: "heading", id: "headers", text: "Response headers" },
    {
      kind: "paragraph",
      text: "Stage response headers from a handler or a `preHandler` hook with `req.setResponseHeader` / `req.appendResponseHeader`. They are merged into the response; a value set by the body wins on conflict.",
    },
    {
      kind: "code",
      snippet: {
        filename: "headers.ts",
        language: "ts",
        code: `app.get("/cached", (req) => {
  req.setResponseHeader("Cache-Control", "public, max-age=3600");
  return reply.json({ ok: true });
});`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "The engine owns the status line, `Content-Length`, and `Connection` header — you never set those by hand.",
    },
  ],
};
