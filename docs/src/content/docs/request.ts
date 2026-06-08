import type { DocPage } from "../../types";

export const requestPage: DocPage = {
  slug: "request",
  title: "The request",
  description: "Reading method, path, params, query, headers, body, cookies, and connection info.",
  blocks: [
    {
      kind: "paragraph",
      text: "Every handler receives a `TokiRequest`. Hot fields — `method`, `path`, `body`, `ip` — are plain properties set once. Query, headers, params, and cookies are parsed lazily on first access, so a handler that never touches them pays nothing.",
    },
    { kind: "heading", id: "basics", text: "Basics" },
    {
      kind: "table",
      headers: ["Property", "Type", "Description"],
      rows: [
        ["`req.method`", "`RouteMethod`", 'The HTTP method, e.g. `"GET"`.'],
        ["`req.path`", "`string`", "Path without the query string, e.g. `/users/42`."],
        ["`req.params`", "`Record<string, string \\| undefined>`", "Captured `:param` / `*` values (frozen)."],
        ["`req.query`", "`URLSearchParams`", "Parsed query string."],
        ["`req.headers`", "`Headers`", "A standard Web `Headers` object."],
        ["`req.cookies`", "`Record<string, string \\| undefined>`", "Parsed `Cookie` header — see [Cookies](/docs/cookies)."],
        ["`req.body`", "`Uint8Array \\| null`", "Raw request body, or `null` when there is none."],
        ["`req.ip`", "`string`", "Peer IP (empty for a unix socket)."],
        ["`req.hostname`", "`string`", "`Host` header without the port."],
        ["`req.protocol`", "`string`", '`"https"` when forwarded as such, else `"http"`.'],
        ["`req.id`", "`string`", "Short id unique to this process run (lazy)."],
        ["`req.log`", "`Logger`", "Per-request logger; silent unless one was configured."],
      ],
    },
    {
      kind: "paragraph",
      text: "There is no `req.url`. The path is on `req.path` and the query lives separately on `req.query`. The HTTP method is on `req.method`, not the path.",
    },
    { kind: "heading", id: "params", text: "Path parameters" },
    {
      kind: "paragraph",
      text: "`req.params` holds the values captured by the route pattern. A `:name` segment lands under that name; a trailing `*` lands under `\"*\"`. The record is frozen and null-prototype, and an absent key reads as `undefined` — so values are typed `string | undefined`. See [Routing](/docs/routing) for the patterns.",
    },
    {
      kind: "code",
      snippet: {
        filename: "params.ts",
        language: "ts",
        code: `app.get("/users/:id/files/*", (req) => {
  const id = req.params.id; // "42"
  const file = req.params["*"]; // "docs/report.pdf"
  return reply.json({ id, file });
});`,
      },
    },
    { kind: "heading", id: "query", text: "Query strings" },
    {
      kind: "paragraph",
      text: "`req.query` is a standard `URLSearchParams`. Use `get` for the first value, `getAll` for repeats, and `has` to test presence. Everything is a string; coerce as needed.",
    },
    {
      kind: "code",
      snippet: {
        filename: "query.ts",
        language: "ts",
        code: `// GET /search?q=zig&page=2&tag=fast&tag=safe
app.get("/search", (req) => {
  const q = req.query.get("q") ?? "";
  const page = Number(req.query.get("page") ?? "1");
  const tags = req.query.getAll("tag"); // ["fast", "safe"]
  const debug = req.query.has("debug");
  return reply.json({ q, page, tags, debug });
});`,
      },
    },
    { kind: "heading", id: "headers", text: "Headers" },
    {
      kind: "paragraph",
      text: "`req.headers` is a Web `Headers` object — case-insensitive lookups, `get`, `has`, and iteration. Reading a header is cheap; toki builds the full `Headers` object only on first access.",
    },
    {
      kind: "code",
      snippet: {
        filename: "headers.ts",
        language: "ts",
        code: `app.get("/whoami", (req) => {
  const auth = req.headers.get("authorization");
  const ua = req.headers.get("user-agent");
  const json = req.headers.get("content-type")?.includes("application/json");
  return reply.json({ auth, ua, wantsJson: json ?? false });
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "For host, protocol, and client IP behind a proxy, prefer the typed accessors: `req.hostname` strips the port from `Host`, and `req.protocol` returns `\"https\"` when `X-Forwarded-Proto` says so.",
    },
    { kind: "heading", id: "body", text: "Reading the body" },
    {
      kind: "paragraph",
      text: "The raw body is on `req.body` as a `Uint8Array` (or `null`). Convenience readers decode it: `req.text()` returns a UTF-8 string (or `\"\"`), and `req.json<T>()` parses it — `T` is an unchecked assertion that throws on malformed input.",
    },
    {
      kind: "code",
      snippet: {
        filename: "body.ts",
        language: "ts",
        code: `app.post("/echo", (req) => {
  const text = req.text();                   // UTF-8 string, "" when empty
  const data = req.json<{ name: string }>(); // parsed JSON, typed by assertion
  const raw = req.body;                       // Uint8Array | null
  return reply.json({ text, name: data.name, bytes: raw?.length ?? 0 });
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`req.body` is a view over an engine-owned buffer, valid only during the synchronous handler call. Read it (or anything derived from it like `req.text()`) before your first `await` — afterwards the bytes may be gone.",
    },
    {
      kind: "paragraph",
      text: "`req.json()` throws on bad input. When the client controls the body, guard the parse and return a `400` rather than letting it reach the error handler.",
    },
    {
      kind: "code",
      snippet: {
        filename: "safe-json.ts",
        language: "ts",
        code: `app.post("/users", (req) => {
  let body: { name?: string };
  try {
    body = req.json();
  } catch {
    return reply.json({ error: "invalid JSON" }, 400);
  }
  if (!body.name) return reply.json({ error: "name required" }, 422);
  return reply.json({ name: body.name }, 201);
});`,
      },
    },
    { kind: "heading", id: "forms", text: "Forms and content-type parsing" },
    {
      kind: "paragraph",
      text: "`req.form` parses a urlencoded or multipart body into `{ fields, files }`, or `null` for any other content type. Files arrive as `{ name, filename, contentType, data }` with `data` a `Uint8Array`. For pluggable parsers selected by content type, use `await req.parseBody<T>()` — it consults registered parsers, falls back to JSON/text/forms, else returns the raw bytes, and memoizes so a side-effectful parser runs once.",
    },
    {
      kind: "code",
      snippet: {
        filename: "forms.ts",
        language: "ts",
        code: `// multipart/form-data upload
app.post("/upload", (req) => {
  const form = req.form;
  if (!form) return reply.empty(415);
  const title = form.fields.title ?? "";
  const sizes = form.files.map((f) => ({ name: f.filename, bytes: f.data.length }));
  return reply.json({ title, files: sizes });
});

// content-type aware parse (see Body parsing for registering parsers)
app.post("/ingest", async (req) => {
  const data = await req.parseBody();
  return reply.json({ received: data });
});`,
      },
    },
    {
      kind: "paragraph",
      text: "See [Body parsing](/docs/body-parsing) for registering custom content-type parsers with `addContentTypeParser`.",
    },
    { kind: "heading", id: "response-headers", text: "Staging response headers" },
    {
      kind: "paragraph",
      text: "From a handler or a `preHandler` hook you can stage headers on the eventual response through the request object. `req.setResponseHeader(name, value)` replaces any staged value for that name; `req.appendResponseHeader(name, value)` adds another line (for repeatable headers like `Set-Cookie`). Both return `this` for chaining. Staged headers merge into the response; a value the response body sets wins on conflict.",
    },
    {
      kind: "code",
      snippet: {
        filename: "stage.ts",
        language: "ts",
        code: `app.get("/report", (req) => {
  req
    .setResponseHeader("Cache-Control", "public, max-age=3600")
    .appendResponseHeader("Vary", "Accept-Encoding");
  return reply.json({ ok: true });
});`,
      },
    },
    {
      kind: "paragraph",
      text: "`req.setCookie` and `req.clearCookie` build on `appendResponseHeader` — see [Cookies](/docs/cookies). To build the response body itself, see [The response](/docs/response).",
    },
  ],
};
