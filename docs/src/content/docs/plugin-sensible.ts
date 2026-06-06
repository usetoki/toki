import type { DocPage } from "../../types";

export const sensiblePluginPage: DocPage = {
  slug: "plugin-sensible",
  title: "Sensible",
  description: "HTTP errors, RFC 9457 problem+json, and assertions.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-sensible` gives you a set of HTTP error constructors, an `assert` helper, and an error handler that renders any thrown error as RFC 9457 `application/problem+json`. Throw from anywhere in a handler and the right status and body come out — with internal 5xx messages kept off the wire.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-sensible`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { sensible, httpErrors, assert } from "@usetoki/toki-sensible";

const app = createApp();
sensible(app); // install the problem+json error handler

app.get("/users/:id", async (req) => {
  const user = await db.find(req.params.id);
  assert(user, 404, "user not found"); // throws httpErrors.notFound — and narrows \`user\`
  if (!user.active) throw httpErrors.forbidden("account suspended");
  return user;
});`,
      },
    },
    {
      kind: "paragraph",
      text: 'A thrown `httpErrors.notFound("user not found")` becomes:',
    },
    {
      kind: "code",
      snippet: {
        filename: "404.json",
        language: "ts",
        code: `// HTTP/1.1 404 Not Found
// Content-Type: application/problem+json
{ "type": "about:blank", "title": "Not Found", "status": 404, "detail": "user not found", "instance": "/users/9" }`,
      },
    },
    {
      kind: "list",
      items: [
        "`httpErrors.*` — `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `tooManyRequests`, … each takes a message and options (`headers`, `details`).",
        "`assert(value, status, message)` — throws when falsy, and narrows the value to non-null for the compiler.",
        "4xx expose their message and `details`; 5xx report a bare reason so internals never leak. Pass `onError` to log them.",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: '`details` are merged into the problem document as RFC 9457 extension members — e.g. `createError(422, "invalid", { details: { errors } })` adds an `errors` field.',
    },
  ],
};
