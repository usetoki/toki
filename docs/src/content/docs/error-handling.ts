import type { DocPage } from "../../types";

export const errorHandlingPage: DocPage = {
  slug: "error-handling",
  title: "Error handling",
  description: "Custom error handlers, not-found handlers, and scope.",
  blocks: [
    {
      kind: "paragraph",
      text: "When a handler throws (or a returned promise rejects), toki runs the nearest error handler. Without one it logs the error and replies `500 Internal Server Error`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "errors.ts",
        language: "ts",
        code: `app.setErrorHandler((req, error) => {
  req.log.error("handler failed", { error: String(error) });
  if (error instanceof NotFoundError) return reply.json({ message: "not found" }, 404);
  return reply.json({ message: "internal error" }, 500);
});

// alias:
app.onError((req, error) => reply.json({ error: String(error) }, 500));`,
      },
    },
    { kind: "heading", id: "scope", text: "Scoped error handlers" },
    {
      kind: "paragraph",
      text: "An error handler set on a [plugin scope](/docs/plugins) only applies to routes registered in that scope (and its children). The nearest one wins, so plugins can shape their own errors without affecting the rest of the app.",
    },
    { kind: "heading", id: "not-found", text: "Not-found handler" },
    {
      kind: "paragraph",
      text: "`setNotFoundHandler(handler)` replaces the default `404`. It runs the root hook chain and receives a normal request, so you can log, redirect, or shape a custom body.",
    },
    {
      kind: "code",
      snippet: {
        filename: "not-found.ts",
        language: "ts",
        code: `app.setNotFoundHandler((req) => {
  return reply.json({ message: \`No route for \${req.method} \${req.path}\` }, 404);
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "An async dispatch that exceeds `requestTimeoutMs` (set on `createApp`) replies `408` and runs any `onTimeout` hooks — see [Hooks](/docs/hooks).",
    },
  ],
};
