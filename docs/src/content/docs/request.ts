import type { DocPage } from "../../types";

export const requestPage: DocPage = {
  slug: "request",
  title: "The request",
  description: "Reading method, path, params, query, headers, body, and connection info.",
  blocks: [
    {
      kind: "paragraph",
      text: "Every handler receives a `TokiRequest`. Hot fields are plain properties; query, headers, and cookies are parsed lazily on first access, so a handler that never reads them pays nothing.",
    },
    { kind: "heading", id: "basics", text: "Basics" },
    {
      kind: "table",
      headers: ["Property", "Type", "Description"],
      rows: [
        ["`req.method`", "`string`", 'The HTTP method, e.g. `"GET"`.'],
        ["`req.path`", "`string`", "Path without the query string."],
        ["`req.params`", "`Record<string, string>`", "Captured `:param` / `*` values."],
        ["`req.query`", "`URLSearchParams`", "Parsed query string."],
        ["`req.headers`", "`Headers`", "A standard Web `Headers` object."],
        ["`req.cookies`", "`Record<string, string>`", "Parsed `Cookie` header — see [Cookies](/docs/cookies)."],
        ["`req.ip`", "`string`", "Peer IP (empty for a unix socket)."],
        ["`req.hostname`", "`string`", "`Host` header without the port."],
        ["`req.protocol`", "`string`", '`"https"` when forwarded as such, else `"http"`.'],
        ["`req.id`", "`string`", "Short id unique to this process run."],
        ["`req.log`", "`Logger`", "Per-request logger."],
      ],
    },
    { kind: "heading", id: "query", text: "Query and headers" },
    {
      kind: "code",
      snippet: {
        filename: "query.ts",
        language: "ts",
        code: `app.get("/search", (req) => {
  const q = req.query.get("q") ?? "";
  const page = Number(req.query.get("page") ?? "1");
  const accept = req.headers.get("accept");
  return reply.json({ q, page, accept });
});`,
      },
    },
    { kind: "heading", id: "body", text: "Reading the body" },
    {
      kind: "paragraph",
      text: "The raw body is on `req.body` as a `Uint8Array` (or `null`). Convenience readers decode it; `req.json<T>()` is an unchecked assertion that throws on malformed input.",
    },
    {
      kind: "code",
      snippet: {
        filename: "body.ts",
        language: "ts",
        code: `app.post("/echo", (req) => {
  const text = req.text();                 // UTF-8 string
  const data = req.json<{ name: string }>(); // parsed JSON, typed by assertion
  const raw = req.body;                     // Uint8Array | null
  return reply.json({ text, name: data.name, bytes: raw?.length ?? 0 });
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`req.body` is a view over an engine-owned buffer that is valid only during the handler call. Read it before any `await`.",
    },
    {
      kind: "paragraph",
      text: "For forms and pluggable parsers, see [Body parsing](/docs/body-parsing).",
    },
  ],
};
