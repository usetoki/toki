import type { DocPage } from "../../types";

export const routingPage: DocPage = {
  slug: "routing",
  title: "Routing",
  description: "HTTP methods, path parameters, wildcards, and route groups.",
  blocks: [
    {
      kind: "paragraph",
      text: "Register a route with the method helper and a handler. Exact paths are matched by an O(1) map; `:param` and `*` routes are matched natively on a miss.",
    },
    {
      kind: "code",
      snippet: {
        filename: "routes.ts",
        language: "ts",
        code: `app.get("/health", () => reply.text("ok"));
app.post("/users", (req) => reply.json(req.json(), 201));
app.put("/users/:id", (req) => reply.json({ id: req.params.id }));
app.patch("/users/:id", handler);
app.delete("/users/:id", handler);
app.options("/users", handler);
app.head("/users", handler);

// or by variable method name:
app.route("GET", "/ping", () => reply.text("pong"));`,
      },
    },
    { kind: "heading", id: "params", text: "Path parameters" },
    {
      kind: "paragraph",
      text: "A `:name` segment captures one path segment, available on `req.params`. A trailing `*` captures the rest of the path under the key `*`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "params.ts",
        language: "ts",
        code: `app.get("/users/:id/posts/:postId", (req) => {
  return reply.json({ user: req.params.id, post: req.params.postId });
});

app.get("/files/*", (req) => {
  return reply.json({ path: req.params["*"] }); // e.g. "a/b/c.txt"
});`,
      },
    },
    { kind: "heading", id: "options", text: "Per-route options" },
    {
      kind: "paragraph",
      text: "Pass an options object before the handler to attach a validation schema or route-scoped hooks.",
    },
    {
      kind: "code",
      snippet: {
        filename: "with-options.ts",
        language: "ts",
        code: `app.post(
  "/users",
  {
    schema: { body: { type: "object", required: ["name"] } },
    preHandler: (req) => {
      if (!req.headers.get("authorization")) return reply.empty(401);
    },
  },
  (req) => reply.json(req.json(), 201),
);`,
      },
    },
    { kind: "heading", id: "groups", text: "Route groups" },
    {
      kind: "paragraph",
      text: "`group(prefix, build)` mounts routes under a shared path prefix with their own middleware. For full encapsulation (hooks, decorators, error handlers), use [plugins](/docs/plugins) instead.",
    },
    {
      kind: "code",
      snippet: {
        filename: "groups.ts",
        language: "ts",
        code: `app.group("/api/v1", (api) => {
  api.use(authMiddleware);
  api.get("/me", (req) => reply.json(req.user));
  api.get("/posts", listPosts);
});`,
      },
    },
    { kind: "heading", id: "head-options", text: "HEAD, OPTIONS, 404 and 405" },
    {
      kind: "list",
      items: [
        "A `HEAD` request is auto-served from the matching `GET` route — headers and `Content-Length`, no body.",
        "An unmatched method on a known path returns `405` with an `Allow` header.",
        "An unmatched path returns `404` (or your [not-found handler](/docs/error-handling)).",
        "A request with a `Transfer-Encoding` header is rejected with `400` — toki frames bodies by `Content-Length` only.",
      ],
    },
  ],
};
