import type { DocPage } from "../../types";

export const validationPage: DocPage = {
  slug: "validation",
  title: "Validation & schemas",
  description: "Validate request bodies, params, query, and serialize responses by schema.",
  blocks: [
    {
      kind: "paragraph",
      text: "Attach a JSON Schema to a route via its options. Toki validates the matching parts of the request and replies `400` on failure, with custom messages when you supply them.",
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
        properties: {
          name: { type: "string", minLength: 2 },
          email: { type: "string", format: "email" },
        },
        errorMessage: {
          required: { name: "name is required", email: "email is required" },
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
      kind: "table",
      headers: ["Key", "Validates"],
      rows: [
        ["`schema.body`", "The parsed request body."],
        ["`schema.params`", "The captured `:param` values."],
        ["`schema.query`", "The query string."],
        ["`schema.response`", "A map of status code to response schema (serialization)."],
      ],
    },
    { kind: "heading", id: "response", text: "Response serialization" },
    {
      kind: "paragraph",
      text: "A `response` schema both documents and serializes the reply — only the declared fields are emitted, which is faster than generic `JSON.stringify` and prevents leaking extra fields.",
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
      kind: "paragraph",
      text: "The standalone `validate(schema, value)` and `serialize(schema, value)` helpers are exported for use outside a route.",
    },
  ],
};
