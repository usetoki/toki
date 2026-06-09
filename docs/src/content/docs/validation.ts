import type { DocPage } from "../../types";

export const validationPage: DocPage = {
  slug: "validation",
  title: "Validation & schemas",
  description: "Validate request bodies, params, query, and headers against a JSON Schema; serialize responses by schema.",
  blocks: [
    {
      kind: "paragraph",
      text: "Attach a JSON Schema to a route via its options. Toki validates the matching parts of the request before your handler runs and replies `400` on failure. The schema is a compact, dependency-free subset of JSON Schema: enough for the shapes real APIs use, not a full draft implementation.",
    },
    {
      kind: "code",
      snippet: {
        filename: "validate.ts",
        language: "ts",
        code: `app.post(
  "/users",
  {
    schema: {
      body: {
        type: "object",
        required: ["name", "email"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          email: { type: "string", format: "email" },
        },
      },
    },
  },
  (req) => reply.json({ created: req.json<{ name: string }>().name }, 201),
);`,
      },
    },
    { kind: "heading", id: "what", text: "What you can validate" },
    {
      kind: "paragraph",
      text: "A `RouteSchema` has up to five keys. Each is an independent `JSONSchema`; supply only the ones you need.",
    },
    {
      kind: "table",
      headers: ["Key", "Validates", "Source"],
      rows: [
        ["`schema.body`", "The request body, parsed as JSON.", "`req.json()`"],
        ["`schema.params`", "The captured `:param` values.", "`req.params`"],
        ["`schema.query`", "The query string.", "`req.query`"],
        ["`schema.headers`", "The request headers.", "`req.headers`"],
        ["`schema.response`", "A map of status code → response schema (serialization, not validation).", "the handler result"],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Params, query, and headers are strings on the wire. Toki coerces them to the declared `number`, `integer`, or `boolean` before validating, so `?limit=20` checks against `{ type: \"integer\" }`. A blank value stays a string so it fails `number` validation rather than silently coercing to `0`. Body values are not coerced — they come from `JSON.parse`.",
    },
    { kind: "heading", id: "keywords", text: "Supported keywords" },
    {
      kind: "table",
      headers: ["Keyword", "Applies to", "Effect"],
      rows: [
        ["`type`", "any", "`object` / `array` / `string` / `number` / `integer` / `boolean` / `null`."],
        ["`properties`", "object", "Per-key sub-schemas (only checked when the key is present)."],
        ["`required`", "object", "Own keys that must be present (inherited keys don't count)."],
        ["`additionalProperties: false`", "object", "Reject any key not in `properties`."],
        ["`items`", "array", "Sub-schema applied to every element."],
        ["`enum`", "any", "Value must equal one of the listed values."],
        ["`nullable`", "any", "Allow `null` in addition to `type`."],
        ["`minLength` / `maxLength`", "string", "Length bounds."],
        ["`pattern`", "string", "Regex the value must match."],
        ["`format`", "string", "`email` / `uuid` / `date-time` / `uri`."],
        ["`minimum` / `maximum`", "number", "Inclusive numeric bounds."],
      ],
    },
    { kind: "heading", id: "params-query", text: "Params, query, and headers" },
    {
      kind: "paragraph",
      text: "Validate path params and the query string the same way. Coercion means you can declare numeric and boolean types directly.",
    },
    {
      kind: "code",
      snippet: {
        filename: "params-query.ts",
        language: "ts",
        code: `app.get(
  "/posts/:id/comments",
  {
    schema: {
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
      query: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          unread: { type: "boolean" },
        },
      },
    },
  },
  (req) => {
    // already validated + coerced; safe to read
    const limit = Number(req.query.get("limit") ?? 20);
    return reply.json(listComments(req.params.id, limit));
  },
);`,
      },
    },
    { kind: "heading", id: "errors", text: "Error format" },
    {
      kind: "paragraph",
      text: "On failure toki collects every error and replies `400` with this body. `message` is the errors joined by `\"; \"`; `errors` is the full array. Each message is prefixed by its location (`body`, `params`, `query`, `headers`) and path.",
    },
    {
      kind: "code",
      snippet: {
        filename: "error-response.ts",
        language: "ts",
        code: `// POST /users with { "name": "A" } (email missing, name too short)
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body.name must be at least 2 characters; body.email is required",
  "errors": [
    "body.name must be at least 2 characters",
    "body.email is required"
  ]
}`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "When the body fails to parse as JSON at all, the response is a single error: `\"body must be valid JSON\"`. Validation runs in a `preValidation`/validation step, so a `400` here skips your handler entirely.",
    },
    { kind: "heading", id: "custom-messages", text: "Custom error messages" },
    {
      kind: "paragraph",
      text: "Set `errorMessage` on any schema. A string overrides every failure for that schema; an object overrides per keyword (`type`, `minLength`, `pattern`, `format`, …). For `required`, give a generic string or a per-property map.",
    },
    {
      kind: "code",
      snippet: {
        filename: "messages.ts",
        language: "ts",
        code: `app.post(
  "/signup",
  {
    schema: {
      body: {
        type: "object",
        required: ["email", "age"],
        properties: {
          email: {
            type: "string",
            format: "email",
            errorMessage: { format: "enter a valid email address" },
          },
          age: {
            type: "integer",
            minimum: 18,
            errorMessage: { minimum: "you must be 18 or older" },
          },
        },
        errorMessage: {
          required: { email: "email is required", age: "age is required" },
        },
      },
    },
  },
  () => reply.empty(201),
);`,
      },
    },
    { kind: "heading", id: "response", text: "Response serialization" },
    {
      kind: "paragraph",
      text: "A `response` schema both documents and serializes the reply: only declared fields are emitted, which is faster than generic `JSON.stringify` and prevents leaking extra fields. It is matched against the response status, so you can shape `200` and `404` differently. It does not validate the handler result; it projects it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "serialize.ts",
        language: "ts",
        code: `app.get(
  "/users/:id",
  {
    schema: {
      response: {
        200: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
    },
  },
  (req) => reply.json({ id: req.params.id, name: "Ada", secret: "hidden" }),
  // -> { "id": "...", "name": "Ada" }  (secret is dropped)
);`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Response serialization only runs for a plain value returned from the handler at the matched status. A built `reply.json(...)` or `reply.text(...)` is already a finished response and bypasses the schema; return the raw object if you want it projected.",
    },
    { kind: "heading", id: "standalone", text: "Standalone helpers" },
    {
      kind: "paragraph",
      text: "`validate(schema, value)` returns an array of error strings (empty = valid), and `serialize(schema, value)` returns a JSON string projected to the schema. Both are exported for use outside a route: validating a config file, a queue message, or a third-party payload.",
    },
    {
      kind: "code",
      snippet: {
        filename: "standalone.ts",
        language: "ts",
        code: `import { validate, serialize, type JSONSchema } from "@usetoki/toki";

const schema: JSONSchema = {
  type: "object",
  required: ["host", "port"],
  properties: {
    host: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1, maximum: 65535 },
  },
};

const errors = validate(schema, loadConfig());
if (errors.length > 0) throw new Error(\`bad config: \${errors.join("; ")}\`);

const json = serialize(schema, { host: "localhost", port: 5432, pw: "x" });
// -> {"host":"localhost","port":5432}  (pw dropped)`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "A `pattern` runs against attacker-controlled input. As a ReDoS guard, toki refuses to feed a regex any value longer than the schema's `maxLength` (or 4096 when none is set) and fails it instead. Anchor your patterns and avoid nested quantifiers, and always pair `pattern` with a sensible `maxLength`.",
    },
  ],
};
