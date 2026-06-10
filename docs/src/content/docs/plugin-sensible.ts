import type { DocPage } from "../../types";

export const sensiblePluginPage: DocPage = {
  slug: "plugin-sensible",
  title: "Sensible",
  description: "HTTP errors, RFC 9457 problem+json, and assertions.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-sensible` gives you a set of HTTP error constructors, an `assert` helper, and an error handler that renders any thrown error as RFC 9457 `application/problem+json`. Throw from anywhere in a handler and the right status and body come out, with internal 5xx messages kept off the wire. Use it when you want consistent, machine-readable error responses without writing a try/catch in every route.",
    },
    {
      kind: "heading",
      id: "install",
      text: "Install",
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
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "Call `sensible(app)` once to install the error handler. Then throw `httpErrors.*` or call `assert` — no try/catch needed.",
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
  assert(user, 404, "user not found"); // throws notFound — and narrows \`user\` to non-null
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
// Content-Type: application/problem+json; charset=utf-8
{ "type": "about:blank", "title": "Not Found", "status": 404, "detail": "user not found", "instance": "/users/9" }`,
      },
    },
    {
      kind: "heading",
      id: "errors",
      text: "The error constructors",
    },
    {
      kind: "paragraph",
      text: "`httpErrors` has a named constructor per status — `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `tooManyRequests`, and the rest. Each takes a message and an options object. Use `headers` to set response headers that belong to the error (a `Retry-After`, a `WWW-Authenticate`), and `details` to add extension members.",
    },
    {
      kind: "code",
      snippet: {
        filename: "headers.ts",
        language: "ts",
        code: `import { httpErrors } from "@usetoki/toki-sensible";

// 429 with a Retry-After header
throw httpErrors.tooManyRequests("slow down", { headers: { "Retry-After": "30" } });

// 401 that tells the client how to authenticate
throw httpErrors.unauthorized("token expired", {
  headers: { "WWW-Authenticate": 'Bearer realm="api", error="invalid_token"' },
});`,
      },
    },
    {
      kind: "heading",
      id: "details",
      text: "Validation details",
    },
    {
      kind: "paragraph",
      text: "`details` are merged into the problem document as RFC 9457 extension members, which is perfect for a field-level validation report. Use `createError(status, message, options)` for any status that doesn't have a named constructor.",
    },
    {
      kind: "code",
      snippet: {
        filename: "validate.ts",
        language: "ts",
        code: `import { createError } from "@usetoki/toki-sensible";

throw createError(422, "validation failed", {
  details: { errors: [{ field: "email", message: "must be a valid address" }] },
});
// => { ..., "status": 422, "detail": "validation failed", "errors": [ ... ] }`,
      },
    },
    {
      kind: "heading",
      id: "5xx",
      text: "5xx stay private",
    },
    {
      kind: "paragraph",
      text: "A 4xx exposes its message and `details`; a 5xx (or any non-HTTP thrown value) reports a bare reason so internals never leak to the client. Pass `onError` to `sensible` to log the real error server-side. You can also map a status to a problem `type` URI.",
    },
    {
      kind: "code",
      snippet: {
        filename: "logging.ts",
        language: "ts",
        code: `sensible(app, {
  onError: (err, req) => logger.error({ err, path: req.path }, "request failed"),
  type: (status) => \`https://api.example.com/problems/\${status}\`,
});

// a thrown TypeError, or httpErrors.internalServerError("db down"), renders as:
// { "type": "...", "title": "Internal Server Error", "status": 500, "detail": "Internal Server Error", ... }`,
      },
    },
    {
      kind: "heading",
      id: "interop",
      text: "Interop with other plugins",
    },
    {
      kind: "paragraph",
      text: "The handler renders any error-like object that carries a numeric `statusCode` in the 400–599 range — so a `MultipartError` from toki-multipart-storage, or your own thrown object, comes out as problem+json too. `isHttpError(value)` tells you whether a value would be treated as one.",
    },
    {
      kind: "heading",
      id: "api",
      text: "API",
    },
    {
      kind: "table",
      headers: ["Export", "Signature", "Notes"],
      rows: [
        ["sensible", "(app, options?) => void", "Installs the problem+json error handler."],
        [
          "httpErrors.*",
          "(message?, options?) => HttpError",
          "Named constructor per status; `headers`, `details`, `cause`.",
        ],
        [
          "createError",
          "(status, message?, options?) => HttpError",
          "Build an error for any status.",
        ],
        [
          "assert",
          "(cond, status, message?, options?)",
          "Throws when falsy; narrows the value for the compiler.",
        ],
        [
          "isHttpError",
          "(value) => boolean",
          "True for an HttpError or any `{ statusCode: 400–599 }`.",
        ],
        [
          "problemJson",
          "(options?) => ErrorHandler",
          "The handler itself, if you want to install it manually.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "`assert` has an `asserts condition` return type, so after `assert(user, 404)` the compiler treats `user` as non-null. One line replaces the null-check and the throw.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "A non-serializable `details` (a bigint, a circular reference) won't crash the handler; it falls back to the standard problem members alone. Keep `details` JSON-safe so your extension fields actually reach the client.",
    },
  ],
};
