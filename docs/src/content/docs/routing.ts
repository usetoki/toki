import type { DocPage } from "../../types";

export const routingPage: DocPage = {
  slug: "routing",
  title: "Routing",
  description: "HTTP methods, path parameters, wildcards, route options, and groups.",
  blocks: [
    {
      kind: "paragraph",
      text: "A route is a method, a path, and a handler. Register it with the method helper. Exact paths are matched by an O(1) map in the native engine; `:param` and `*` patterns are matched on a miss. Matching happens before any JavaScript runs, so an unmatched request never wakes a handler.",
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
app.head("/users", handler);
app.options("/users", handler);

// any method token, including non-standard ones, via route():
app.route("GET", "/ping", () => reply.text("pong"));
app.route("PURGE", "/cache", purgeHandler);`,
      },
    },
    { kind: "heading", id: "methods", text: "Method helpers" },
    {
      kind: "paragraph",
      text: "The verb helpers register one route on the app (or any [scope](/docs/plugins)). `get`/`post`/`put`/`patch`/`delete` also take a per-route options object before the handler; `head`/`options`/`route` take only a handler. Every helper returns the instance, so calls chain.",
    },
    {
      kind: "table",
      headers: ["Call", "Method", "Options arg"],
      rows: [
        ["`app.get(path, handler)`", "`GET`", "yes"],
        ["`app.post(path, handler)`", "`POST`", "yes"],
        ["`app.put(path, handler)`", "`PUT`", "yes"],
        ["`app.patch(path, handler)`", "`PATCH`", "yes"],
        ["`app.delete(path, handler)`", "`DELETE`", "yes"],
        ["`app.head(path, handler)`", "`HEAD`", "no"],
        ["`app.options(path, handler)`", "`OPTIONS`", "no"],
        ["`app.route(method, path, handler)`", "any token", "no"],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "There is no `app.all`. To answer several methods on one path, register each, or use `route()` per method. `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`HEAD`/`OPTIONS` route natively; any other token is reachable through `route()`.",
    },
    { kind: "heading", id: "params", text: "Path parameters" },
    {
      kind: "paragraph",
      text: "A `:name` segment captures exactly one path segment and lands on `req.params` under that name. A handler can read any number of them. An absent param key reads as `undefined`, and `req.params` is a frozen, null-prototype record.",
    },
    {
      kind: "code",
      snippet: {
        filename: "params.ts",
        language: "ts",
        code: `// single param
app.get("/users/:id", (req) => {
  return reply.json({ id: req.params.id });
});

// nested params
app.get("/users/:id/posts/:postId", (req) => {
  return reply.json({ user: req.params.id, post: req.params.postId });
});`,
      },
    },
    {
      kind: "paragraph",
      text: "Params are always strings — the wire has no types. Coerce and validate at the edge of the handler so the rest of your code works with real values.",
    },
    {
      kind: "code",
      snippet: {
        filename: "coerce.ts",
        language: "ts",
        code: `app.get("/users/:id", (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return reply.json({ error: "bad id" }, 400);
  }
  return reply.json({ id });
});`,
      },
    },
    { kind: "heading", id: "wildcards", text: "Wildcards" },
    {
      kind: "paragraph",
      text: "A trailing `*` captures the rest of the path — everything after the prefix, slashes included — under the key `*`. Use it for catch-all routes, asset paths, or proxy passthroughs.",
    },
    {
      kind: "code",
      snippet: {
        filename: "wildcard.ts",
        language: "ts",
        code: `app.get("/files/*", (req) => {
  const rest = req.params["*"]; // e.g. "images/logo.png"
  return reply.json({ path: rest });
});

// a bare catch-all (handy with cors() preflight, see Security)
app.options("/*", () => reply.empty(204));`,
      },
    },
    { kind: "heading", id: "precedence", text: "Matching and precedence" },
    {
      kind: "paragraph",
      text: "An exact path always wins over a pattern: `/users/me` is served by its own route even when `/users/:id` exists. Among patterns, the engine prefers a `:param` over a `*` at the same depth, so specific beats greedy. Registration order does not change which route matches.",
    },
    {
      kind: "list",
      items: [
        "`GET /users/me` → matches `/users/me` (exact), not `/users/:id`.",
        "`GET /users/42` → matches `/users/:id` (`req.params.id === \"42\"`).",
        "`GET /files/a/b.txt` → matches `/files/*` (`req.params[\"*\"] === \"a/b.txt\"`).",
      ],
    },
    { kind: "heading", id: "query", text: "Query strings" },
    {
      kind: "paragraph",
      text: "The query string is not part of the route path. Read it from `req.query`, a standard `URLSearchParams`, parsed lazily on first access. See [The request](/docs/request) for the full surface.",
    },
    {
      kind: "code",
      snippet: {
        filename: "query.ts",
        language: "ts",
        code: `// GET /search?q=zig&page=2&tag=fast&tag=safe
app.get("/search", (req) => {
  const q = req.query.get("q") ?? "";
  const page = Number(req.query.get("page") ?? "1");
  const tags = req.query.getAll("tag"); // ["fast", "safe"]
  return reply.json({ q, page, tags });
});`,
      },
    },
    { kind: "heading", id: "options", text: "Per-route options" },
    {
      kind: "paragraph",
      text: "Pass an options object before the handler to attach a validation `schema`, route-scoped hooks (`preValidation`, `preHandler`, `preSerialization`), or arbitrary `config`. A hook may return a response to short-circuit — the handler and remaining steps are skipped.",
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Purpose"],
      rows: [
        ["`schema`", "`RouteSchema`", "Validate body/query/params and serialize the response."],
        ["`preValidation`", "`Middleware | Middleware[]`", "Run before schema validation."],
        ["`preHandler`", "`Middleware | Middleware[]`", "Run after validation, before the handler."],
        ["`preSerialization`", "`SerializationHook | SerializationHook[]`", "Transform a plain value before JSON encoding."],
        ["`config`", "`Record<string, unknown>`", "Arbitrary per-route data, reachable from hooks."],
      ],
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
    {
      kind: "paragraph",
      text: "See [Validation](/docs/validation) for the schema format and [Hooks](/docs/hooks) for the lifecycle order.",
    },
    { kind: "heading", id: "rest", text: "A small REST resource" },
    {
      kind: "paragraph",
      text: "The five verbs on a `/posts` collection. Chaining keeps the resource readable in one block.",
    },
    {
      kind: "code",
      snippet: {
        filename: "posts.ts",
        language: "ts",
        code: `const posts = new Map<string, { id: string; title: string }>();

app
  .get("/posts", () => reply.json([...posts.values()]))
  .post("/posts", (req) => {
    const body = req.json<{ title: string }>();
    const id = crypto.randomUUID();
    const post = { id, title: body.title };
    posts.set(id, post);
    return reply.json(post, 201);
  })
  .get("/posts/:id", (req) => {
    const post = posts.get(req.params.id!);
    return post ? reply.json(post) : reply.empty(404);
  })
  .put("/posts/:id", (req) => {
    const id = req.params.id!;
    if (!posts.has(id)) return reply.empty(404);
    const post = { id, title: req.json<{ title: string }>().title };
    posts.set(id, post);
    return reply.json(post);
  })
  .delete("/posts/:id", (req) => {
    return posts.delete(req.params.id!) ? reply.empty(204) : reply.empty(404);
  });`,
      },
    },
    { kind: "heading", id: "groups", text: "Route groups" },
    {
      kind: "paragraph",
      text: "`group(prefix, build)` mounts routes under a shared path prefix with their own middleware. The group's middleware runs after the app's, before the handler. A group is a thin path/middleware grouping; for full encapsulation (hooks, decorators, error handlers, a load order), use a [plugin](/docs/plugins) instead.",
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
  api.post("/posts", createPost);
});
// → GET /api/v1/me, GET /api/v1/posts, POST /api/v1/posts`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "`use()` on a group applies even when called after a route is added — middleware resolves at `listen()`, not at registration. Order your `get`/`post`/`use` calls however reads best.",
    },
    { kind: "heading", id: "head-options", text: "HEAD, 404 and 405" },
    {
      kind: "list",
      items: [
        "A `HEAD` request is auto-served from the matching `GET` route — headers and `Content-Length`, no body. Register an explicit `HEAD` route only to override that.",
        "An unmatched method on a known path returns `405` with an `Allow` header listing the methods that path does accept.",
        "An unmatched path returns `404`, or your [not-found handler](/docs/error-handling) when one is set with `setNotFoundHandler`.",
        "A request carrying a `Transfer-Encoding` header is rejected with `400` — toki frames bodies by `Content-Length` only.",
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "not-found.ts",
        language: "ts",
        code: `app.setNotFoundHandler((req) => {
  return reply.json({ error: "not found", path: req.path }, 404);
});`,
      },
    },
  ],
};
