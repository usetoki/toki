import type { DocPage } from "../../types";

export const errorHandlingPage: DocPage = {
  slug: "error-handling",
  title: "Error handling",
  description: "Turn thrown errors into responses with error handlers, map status codes, handle not-found, and catch async failures.",
  blocks: [
    {
      kind: "paragraph",
      text: "When a handler throws (or a returned promise rejects) toki catches it and runs the nearest error handler. With no handler it logs the error and replies `500 Internal Server Error`. The same path covers sync throws, async rejections, and throws from a `preHandler` or other [hook](/docs/hooks).",
    },
    { kind: "heading", id: "set", text: "setErrorHandler" },
    {
      kind: "paragraph",
      text: "`setErrorHandler((req, error) => result)` registers a handler for the scope. It receives the request and the thrown value (typed `unknown`, so narrow it yourself) and returns a normal handler result: a `reply`, a string, or a plain value sent as JSON. `onError` is an alias.",
    },
    {
      kind: "code",
      snippet: {
        filename: "errors.ts",
        language: "ts",
        code: `app.setErrorHandler((req, error) => {
  req.log.error("handler failed", { error: String(error) });
  if (error instanceof ValidationError) return reply.json({ message: error.message }, 422);
  return reply.json({ message: "internal error" }, 500);
});

// alias:
app.onError((req, error) => reply.json({ error: String(error) }, 500));`,
      },
    },
    { kind: "heading", id: "typed", text: "Typed HTTP errors" },
    {
      kind: "paragraph",
      text: "Toki ships no error class — throw your own. A small `HttpError` carrying a status code lets handlers fail by throwing, and one error handler maps every throw to a clean response. This keeps the happy path free of status plumbing.",
    },
    {
      kind: "code",
      snippet: {
        filename: "http-error.ts",
        language: "ts",
        code: `class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

app.setErrorHandler((req, error) => {
  if (error instanceof HttpError) {
    return reply.json({ statusCode: error.status, message: error.message }, error.status);
  }
  req.log.error("unhandled", { error: String(error) });
  return reply.json({ statusCode: 500, message: "Internal Server Error" }, 500);
});

app.get("/orders/:id", (req) => {
  const order = findOrder(req.params.id);
  if (!order) throw new HttpError(404, "order not found");
  if (!order.visibleTo(req)) throw new HttpError(403, "forbidden");
  return reply.json(order);
});`,
      },
    },
    { kind: "heading", id: "async", text: "Async errors" },
    {
      kind: "paragraph",
      text: "A rejected promise from an `async` handler is caught exactly like a sync throw; no extra try/catch needed. `await` and let it throw, and the error handler runs.",
    },
    {
      kind: "code",
      snippet: {
        filename: "async-errors.ts",
        language: "ts",
        code: `app.post("/charge", async (req) => {
  const body = req.json<{ amount: number }>();
  // if charge() rejects, the error handler turns it into a response
  const receipt = await charge(req.user, body.amount);
  return reply.json(receipt, 201);
});`,
      },
    },
    { kind: "heading", id: "validation-errors", text: "Validation errors" },
    {
      kind: "paragraph",
      text: "Schema validation failures do not reach the error handler. A failing [schema](/docs/validation) short-circuits with a `400` before the handler runs, returning a structured body (`statusCode`, `error`, `message`, `errors`). The error handler is only for thrown values. Catch a validation failure in a `preValidation` hook if you need to reshape it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "validation-error.ts",
        language: "ts",
        code: `// the framework reply for a failed body schema:
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body.email is required",
  "errors": ["body.email is required"]
}`,
      },
    },
    { kind: "heading", id: "scope", text: "Scoped error handlers" },
    {
      kind: "paragraph",
      text: "An error handler set on a [plugin scope](/docs/plugins) applies only to routes in that scope and its children. Toki walks the scope ancestry and the nearest handler wins, so a plugin can shape its own errors (a JSON API error body for `/api`, an HTML page for the site) without touching the rest of the app.",
    },
    {
      kind: "code",
      snippet: {
        filename: "scoped.ts",
        language: "ts",
        code: `// root: HTML error page
app.setErrorHandler((req, error) => reply.html(errorPage(error), 500));

app.register(
  (api) => {
    // overrides the root handler for everything under /api
    api.setErrorHandler((req, error) =>
      reply.json({ message: String(error) }, 500),
    );
    api.get("/widgets", () => {
      throw new Error("boom"); // -> JSON, not HTML
    });
  },
  { prefix: "/api" },
);`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "If your error handler itself throws, toki swallows that throw and falls back to the default `500 Internal Server Error`. Keep error handlers simple and side-effect-light, and never let one throw on the data it is meant to format.",
    },
    { kind: "heading", id: "not-found", text: "Not-found handler" },
    {
      kind: "paragraph",
      text: "`setNotFoundHandler(handler)` replaces the default `404`. It is app-global: one per process. It runs the root hook chain and receives a normal request, so you can log, redirect, or shape a custom body. Returning a plain value with no status yields `404`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "not-found.ts",
        language: "ts",
        code: `app.setNotFoundHandler((req) => {
  req.log.warn("no route", { method: req.method, path: req.path });
  return reply.json({ message: \`No route for \${req.method} \${req.path}\` }, 404);
});`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "spa-fallback.ts",
        language: "ts",
        code: `// single-page app: serve index.html for unmatched GETs, JSON 404 otherwise
app.setNotFoundHandler((req) => {
  if (req.method === "GET" && req.headers.get("accept")?.includes("text/html")) {
    return reply.html(indexHtml);
  }
  return reply.json({ message: "not found" }, 404);
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "An async dispatch that exceeds `requestTimeoutMs` (set on `createApp`) replies `408` and runs any `onTimeout` hooks. This is separate from the error handler. See [Hooks](/docs/hooks).",
    },
  ],
};
