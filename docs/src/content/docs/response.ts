import type { DocPage } from "../../types";

export const responsePage: DocPage = {
  slug: "response",
  title: "The response",
  description: "Building responses with reply, status codes, headers, redirects, and bytes.",
  blocks: [
    {
      kind: "paragraph",
      text: "Return a value from a handler and toki sends it. A plain object (or array, number, boolean, null) is serialized as JSON; a string is sent as `text/plain`. For explicit control over the body, status, and content type, return a `reply.*` builder. A handler may be sync or `async`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "shorthand.ts",
        language: "ts",
        code: `app.get("/ping", () => "pong");          // text/plain, 200
app.get("/user", () => ({ id: 1, ok: true })); // application/json, 200
app.get("/count", () => 42);              // application/json: 42
app.get("/strict", () => reply.json({ id: 1 }, 201)); // explicit status`,
      },
    },
    { kind: "heading", id: "reply", text: "The reply builders" },
    {
      kind: "paragraph",
      text: "`reply` is a module-level object (import it from `@usetoki/toki`), not a per-request one; it only describes a response. Every builder takes the status last and defaults sensibly.",
    },
    {
      kind: "table",
      headers: ["Call", "Content-Type", "Default status"],
      rows: [
        ["`reply.text(body, status?)`", "`text/plain; charset=utf-8`", "`200`"],
        ["`reply.html(body, status?)`", "`text/html; charset=utf-8`", "`200`"],
        ["`reply.json(data, status?)`", "`application/json; charset=utf-8`", "`200`"],
        ["`reply.bytes(data, contentType?, status?)`", "`application/octet-stream`", "`200`"],
        ["`reply.empty(status?)`", "`text/plain` (no body)", "`204`"],
        ["`reply.redirect(location, status?)`", "sets `Location`", "`302`"],
        ["`reply.stream(source, options?)`", "`application/octet-stream`", "`200`"],
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
    { kind: "heading", id: "json", text: "JSON and status codes" },
    {
      kind: "paragraph",
      text: "`reply.json(data, status)` stringifies `data` and sets `Content-Type: application/json`. Pass the status as the second argument; there is no separate `.status()` or `.code()` call. The engine owns the status line itself; you only choose the number.",
    },
    {
      kind: "code",
      snippet: {
        filename: "status.ts",
        language: "ts",
        code: `app.post("/orders", (req) => {
  const order = req.json<{ item: string }>();
  if (!order.item) return reply.json({ error: "item required" }, 422);
  return reply.json({ id: crypto.randomUUID(), item: order.item }, 201);
});

app.get("/orders/:id", (req) => {
  const order = lookup(req.params.id!);
  return order ? reply.json(order) : reply.empty(404);
});`,
      },
    },
    { kind: "heading", id: "headers", text: "Custom headers" },
    {
      kind: "paragraph",
      text: "Stage response headers from a handler or a `preHandler` hook with `req.setResponseHeader` (replace) and `req.appendResponseHeader` (add a line). They merge into the response. A staged `Content-Type` overrides the builder's default, folded into a single `Content-Type` line, never duplicated.",
    },
    {
      kind: "code",
      snippet: {
        filename: "headers.ts",
        language: "ts",
        code: `app.get("/cached", (req) => {
  req.setResponseHeader("Cache-Control", "public, max-age=3600");
  req.appendResponseHeader("Vary", "Accept-Encoding");
  return reply.json({ ok: true });
});

// override the content type for a json payload
app.get("/manifest", (req) => {
  req.setResponseHeader("Content-Type", "application/manifest+json");
  return reply.json({ name: "toki" });
});`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "The engine owns the status line, `Content-Length`, and `Connection` header; you never set those by hand. A CR, LF, or space inside a header name or value is stripped, so a header can't split the wire block.",
    },
    { kind: "heading", id: "redirect", text: "Redirects" },
    {
      kind: "paragraph",
      text: "`reply.redirect(location, status?)` sets the `Location` header and an empty body. The default `302` is a temporary redirect; pass `301` for permanent, `303` to force a `GET` after a `POST`, or `307`/`308` to preserve the method.",
    },
    {
      kind: "code",
      snippet: {
        filename: "redirect.ts",
        language: "ts",
        code: `app.get("/old-docs", () => reply.redirect("/docs", 301));

app.post("/login", (req) => {
  // ...authenticate...
  return reply.redirect("/dashboard", 303); // GET the dashboard next
});`,
      },
    },
    { kind: "heading", id: "bytes", text: "Sending raw bytes" },
    {
      kind: "paragraph",
      text: "`reply.bytes(data, contentType?, status?)` sends a `Uint8Array` (or `Buffer`) verbatim: images, generated files, a pre-compressed payload. The content type defaults to `application/octet-stream`; set it to match your data.",
    },
    {
      kind: "code",
      snippet: {
        filename: "bytes.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";

app.get("/logo.png", () => {
  const png = readFileSync("./assets/logo.png");
  return reply.bytes(png, "image/png");
});

app.get("/download", (req) => {
  req.setResponseHeader("Content-Disposition", 'attachment; filename="data.bin"');
  return reply.bytes(new Uint8Array([1, 2, 3, 4]));
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "For static assets on disk, mount a directory with `app.static(prefix, dir)` instead of reading files per request — see [Static files](/docs/static-files).",
    },
    { kind: "heading", id: "stream", text: "Streaming" },
    {
      kind: "paragraph",
      text: '`reply.stream(source, options?)` hands off a chunked response. `source` is an async/sync iterable or a Node `Readable`; each chunk (bytes or a UTF-8 string) is written as it arrives via `Transfer-Encoding: chunked`. A stream bypasses response hooks and serialization; there is no materialized body. For server-sent events, set `contentType: "text/event-stream"`.',
    },
    {
      kind: "code",
      snippet: {
        filename: "stream.ts",
        language: "ts",
        code: `app.get("/feed", () => {
  async function* events() {
    for (let i = 0; i < 3; i++) {
      yield \`data: tick \${i}\\n\\n\`;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return reply.stream(events(), {
    contentType: "text/event-stream",
    headers: [["Cache-Control", "no-cache"]],
  });
});`,
      },
    },
    {
      kind: "paragraph",
      text: "See [Streaming](/docs/streaming) for backpressure, Node `Readable` sources, and the full options.",
    },
  ],
};
