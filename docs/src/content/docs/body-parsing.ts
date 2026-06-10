import type { DocPage } from "../../types";

export const bodyParsingPage: DocPage = {
  slug: "body-parsing",
  title: "Body parsing & forms",
  description:
    "Read JSON, text, urlencoded, multipart, and raw bodies; add custom content-type parsers; size limits.",
  blocks: [
    {
      kind: "paragraph",
      text: "The request body arrives as raw bytes. Toki never parses it for you up front; you choose how to read it, so a route that doesn't need the body pays nothing. Pick a built-in reader by content type, or call `parseBody()` to dispatch automatically.",
    },
    {
      kind: "paragraph",
      text: "Every reader works off `req.body`, a `Uint8Array` (or `null` when there is no body). The buffer is engine-owned and valid only during the handler call, so read it before your first `await`. See the gotcha at the end.",
    },
    { kind: "heading", id: "readers", text: "Built-in readers" },
    {
      kind: "table",
      headers: ["Accessor", "Returns", "Notes"],
      rows: [
        ["`req.body`", "`Uint8Array | null`", "Raw bytes, untouched."],
        ["`req.text()`", "`string`", 'UTF-8 decode; `""` when there is no body.'],
        [
          "`req.json<T>()`",
          "`T`",
          "`JSON.parse` of the text. Throws on malformed input. `T` is an unchecked cast.",
        ],
        [
          "`req.form`",
          "`ParsedForm | null`",
          "Urlencoded or multipart; `null` for any other content type. Lazy + cached.",
        ],
        [
          "`await req.parseBody<T>()`",
          "`Promise<T>`",
          "Dispatch by content type, fall back to built-ins, then raw bytes. Cached.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "`req.json()` does not check the `Content-Type` header — it parses whatever bytes are there. Use a `body` [validation schema](/docs/validation) when you need to reject the wrong shape, or `parseBody()` when you want content-type dispatch.",
    },
    { kind: "heading", id: "json", text: "JSON" },
    {
      kind: "paragraph",
      text: "`req.json<T>()` is synchronous and the fast path for API endpoints. It throws on invalid JSON, so guard it; an uncaught throw becomes a `500` via your [error handler](/docs/error-handling). A `body` schema does the parse and the guard for you and replies `400` on bad JSON.",
    },
    {
      kind: "code",
      snippet: {
        filename: "json.ts",
        language: "ts",
        code: `app.post("/users", (req) => {
  let payload: { name: string; email: string };
  try {
    payload = req.json();
  } catch {
    return reply.json({ message: "body must be valid JSON" }, 400);
  }
  return reply.json({ id: createUser(payload) }, 201);
});`,
      },
    },
    { kind: "heading", id: "text", text: "Text" },
    {
      kind: "paragraph",
      text: "`req.text()` decodes the body as UTF-8. Useful for plain-text payloads, webhooks that post a signed string, or anything you want to hash before parsing.",
    },
    {
      kind: "code",
      snippet: {
        filename: "text.ts",
        language: "ts",
        code: `app.post("/webhook", (req) => {
  const raw = req.text();
  const expected = sign(raw, secret);
  if (req.headers.get("x-signature") !== expected) return reply.empty(401);
  return reply.json(JSON.parse(raw));
});`,
      },
    },
    { kind: "heading", id: "forms", text: "Forms" },
    {
      kind: "paragraph",
      text: "`req.form` is a `ParsedForm` (`{ fields, files }`) for `application/x-www-form-urlencoded` or `multipart/form-data` bodies, and `null` for any other content type. `fields` is a `Record<string, string>` — a repeated name keeps the last value. `files` is an array of uploads, each carrying its field name, filename, content type, and bytes.",
    },
    {
      kind: "table",
      headers: ["`FormFile` field", "Type", "Meaning"],
      rows: [
        ["`name`", "`string`", "The form field name."],
        ["`filename`", "`string`", "The client-supplied filename."],
        ["`contentType`", "`string`", "Part `Content-Type`, default `application/octet-stream`."],
        ["`data`", "`Uint8Array`", "The file bytes."],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "upload.ts",
        language: "ts",
        code: `app.post("/upload", (req) => {
  const form = req.form;
  if (form === null) return reply.empty(415); // not a form body

  const title = form.fields.title; // string | undefined
  const files = form.files.map((f) => ({
    name: f.name,
    filename: f.filename,
    type: f.contentType,
    size: f.data.length,
  }));
  return reply.json({ title, files });
});`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "login-form.ts",
        language: "ts",
        code: `// urlencoded: username=ada&password=secret
app.post("/login", (req) => {
  const form = req.form;
  if (form === null) return reply.empty(415);
  const { username, password } = form.fields;
  if (!username || !checkPassword(username, password)) return reply.empty(401);
  return reply.json({ ok: true });
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "A `multipart/form-data` body with no `boundary` in its `Content-Type` parses as an empty form (`{ fields: {}, files: [] }`) rather than throwing. Don't assume a non-null `form` means fields are present.",
    },
    { kind: "heading", id: "raw", text: "Raw bytes" },
    {
      kind: "paragraph",
      text: "For binary payloads (protobuf, an uploaded image posted as the whole body, a custom wire format) read `req.body` directly. It is the engine buffer with no copy.",
    },
    {
      kind: "code",
      snippet: {
        filename: "raw.ts",
        language: "ts",
        code: `app.put("/blobs/:id", (req) => {
  const bytes = req.body;
  if (bytes === null) return reply.empty(400);
  store(req.params.id, bytes);
  return reply.json({ bytes: bytes.length }, 201);
});`,
      },
    },
    { kind: "heading", id: "parse-body", text: "parseBody" },
    {
      kind: "paragraph",
      text: "`await req.parseBody<T>()` picks a reader by `Content-Type`: first any matching custom parser (nearest scope first), then the built-ins, then the raw bytes. The result is cached, and concurrent callers collapse onto a single parse — a side-effectful custom parser runs exactly once.",
    },
    {
      kind: "table",
      headers: ["Content-Type", "parseBody returns"],
      rows: [
        ["`application/json` or `*+json`", "`req.json()`"],
        ["`text/*`", "`req.text()`"],
        ["`application/x-www-form-urlencoded`, `multipart/form-data`", "`req.form`"],
        ["anything else (no custom parser)", "the raw `Uint8Array`"],
        ["no body", "`undefined`"],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "parse.ts",
        language: "ts",
        code: `app.post("/data", async (req) => {
  const value = await req.parseBody();
  return reply.json({ value });
});`,
      },
    },
    { kind: "heading", id: "content-type-parsers", text: "Custom content-type parsers" },
    {
      kind: "paragraph",
      text: '`addContentTypeParser(type, parser)` registers a parser consulted by `parseBody()`. `type` matches case-insensitively as a prefix (e.g. `"application/xml"`), a `RegExp`, or `"*"` for any. Pass an array to register the same parser for several types. The parser gets `(req, body)` and may be async. A child [scope](/docs/plugins) overrides an ancestor for the same type.',
    },
    {
      kind: "code",
      snippet: {
        filename: "yaml-parser.ts",
        language: "ts",
        code: `import { parse as parseYaml } from "yaml";

app.addContentTypeParser("application/yaml", (req, body) => {
  return parseYaml(Buffer.from(body).toString("utf8"));
});

app.post("/config", async (req) => reply.json(await req.parseBody()));`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "msgpack-parser.ts",
        language: "ts",
        code: `import { decode } from "@msgpack/msgpack";

// one parser for two equivalent media types
app.addContentTypeParser(
  ["application/msgpack", "application/x-msgpack"],
  (req, body) => decode(body),
);

app.post("/ingest", async (req) => {
  const event = await req.parseBody<{ kind: string }>();
  return reply.json({ kind: event.kind });
});`,
      },
    },
    { kind: "heading", id: "size-limits", text: "Size limits" },
    {
      kind: "paragraph",
      text: "The engine caps body size at `maxBodyBytes`, set on `listen` and defaulting to 1 MiB. A request whose body exceeds the cap is rejected natively, before any JS runs: your handler is never invoked, so there is nothing to catch. Raise it for upload endpoints; lower it to shrink your attack surface.",
    },
    {
      kind: "code",
      snippet: {
        filename: "limits.ts",
        language: "ts",
        code: `// allow up to 10 MiB bodies
app.listen(3000, { maxBodyBytes: 10 * 1024 * 1024 });

// a POST with a larger body is refused by the engine; the handler below never runs
app.post("/upload", (req) => reply.json({ bytes: req.body?.length ?? 0 }));`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`maxBodyBytes` is process-wide, not per-route, since toki runs one engine per process. To enforce a tighter per-route cap, check `req.body.length` in a `preHandler` hook and reply `413` yourself.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The body buffer is engine-owned and only valid during the synchronous part of the handler. Read it (`req.body`, `text()`, `json()`, `form`) before your first `await`. `parseBody()` is safe to await because it captures the bytes before yielding.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Requests with `Transfer-Encoding: chunked` are rejected with `400`. Send a `Content-Length`: toki frames bodies by length, and accepting chunked would risk a request-smuggling desync.",
    },
  ],
};
