import type { DocPage } from "../../types";

export const bodyParsingPage: DocPage = {
  slug: "body-parsing",
  title: "Body parsing & forms",
  description: "JSON, text, urlencoded and multipart forms, and custom content-type parsers.",
  blocks: [
    {
      kind: "paragraph",
      text: "Built-in readers cover the common cases. `req.text()` decodes UTF-8, `req.json<T>()` parses JSON, and `req.form` parses urlencoded and `multipart/form-data` bodies.",
    },
    { kind: "heading", id: "forms", text: "Forms" },
    {
      kind: "paragraph",
      text: "`req.form` is a `ParsedForm` (`{ fields, files }`) for urlencoded or multipart bodies, or `null` for any other content type. Each uploaded file carries its field name, filename, content type, and bytes.",
    },
    {
      kind: "code",
      snippet: {
        filename: "upload.ts",
        language: "ts",
        code: `app.post("/upload", (req) => {
  const form = req.form;
  if (form === null) return reply.empty(415);

  const title = form.fields.title;
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
    { kind: "heading", id: "parse-body", text: "parseBody" },
    {
      kind: "paragraph",
      text: "`await req.parseBody<T>()` dispatches by content type to a registered parser, then falls back to the built-ins (JSON / text / form), and finally to the raw bytes. The result is cached.",
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
      text: "`addContentTypeParser(type, parser)` registers a parser for one or more content types, consulted by `parseBody()`. `type` matches case-insensitively as a prefix, a `RegExp`, or `\"*\"` for any. A child scope overrides an ancestor for the same type.",
    },
    {
      kind: "code",
      snippet: {
        filename: "yaml-parser.ts",
        language: "ts",
        code: `import { parse as parseYaml } from "yaml";

app.addContentTypeParser("application/yaml", (req, body) => {
  return parseYaml(Buffer.from(body).toString());
});

app.post("/config", async (req) => reply.json(await req.parseBody()));`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Requests with `Transfer-Encoding: chunked` are rejected with `400`. Send a `Content-Length` — toki frames bodies by length, and accepting chunked would risk a request-smuggling desync.",
    },
  ],
};
