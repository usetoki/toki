import type { DocPage } from "../../types";

export const quickStartPage: DocPage = {
  slug: "quick-start",
  title: "Quick start",
  description: "A guided tour: routes, params, query, a JSON body, a hook, errors, and a plugin.",
  blocks: [
    {
      kind: "paragraph",
      text: "Create an app with `createApp()`, register routes, and call `listen()`. A handler returns a value or a `reply.*` result; toki turns it into a response. This page builds up a small but real server one feature at a time.",
    },
    {
      kind: "code",
      snippet: {
        filename: "server.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp({ logger: "info" });

app.get("/", () => reply.text("Hello, World!"));

app.listen(3000);
console.log("listening on http://127.0.0.1:3000");`,
      },
    },
    { kind: "heading", id: "run-it", text: "Run it" },
    {
      kind: "paragraph",
      text: "Node 22+ runs TypeScript directly via type-stripping, so no build step is needed:",
    },
    {
      kind: "code",
      snippet: { filename: "terminal", language: "bash", code: "node server.ts" },
    },
    { kind: "heading", id: "params-and-query", text: "Params and query" },
    {
      kind: "paragraph",
      text: "Route patterns capture `:name` segments into `req.params`. The query string is a standard `URLSearchParams` on `req.query`. Both parse lazily — you pay only for what you read. See [Routing](/docs/routing) for wildcards and groups.",
    },
    {
      kind: "code",
      snippet: {
        filename: "params.ts",
        language: "ts",
        code: `app.get("/users/:id", (req) => {
  return reply.json({ id: req.params.id });
});

// GET /search?q=toki&limit=10
app.get("/search", (req) => {
  const q = req.query.get("q") ?? "";
  const limit = Number(req.query.get("limit") ?? 20);
  return reply.json({ q, limit });
});`,
      },
    },
    { kind: "heading", id: "json-body", text: "Reading a JSON body" },
    {
      kind: "paragraph",
      text: "`req.json<T>()` parses the body as JSON synchronously. The type parameter is an unchecked assertion — for real validation, attach a [schema](/docs/validation). `req.text()` gives you the raw string; `req.parseBody()` picks a parser by content type. See [Body parsing](/docs/body-parsing).",
    },
    {
      kind: "code",
      snippet: {
        filename: "body.ts",
        language: "ts",
        code: `app.post("/users", (req) => {
  const body = req.json<{ name: string }>();
  return reply.json({ created: body.name }, 201);
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The body is backed by an engine-owned buffer that is valid only during the synchronous part of the handler. Read it (`req.json()`, `req.text()`, `req.body`) before your first `await`.",
    },
    { kind: "heading", id: "a-hook", text: "Adding a hook" },
    {
      kind: "paragraph",
      text: "Hooks run around handlers. `onRequest` fires first — log, authenticate, or short-circuit by returning a response. A `preHandler` that returns a value skips the handler entirely. See [Hooks](/docs/hooks) and [Middleware](/docs/middleware).",
    },
    {
      kind: "code",
      snippet: {
        filename: "hook.ts",
        language: "ts",
        code: `// log every request
app.addHook("onRequest", (req) => {
  req.log.info("request", { method: req.method, path: req.path });
});

// gate everything behind an API key; returning a reply short-circuits
app.addHook("preHandler", (req) => {
  if (req.headers.get("x-api-key") !== "secret") {
    return reply.json({ error: "unauthorized" }, 401);
  }
});`,
      },
    },
    { kind: "heading", id: "errors", text: "Handling errors" },
    {
      kind: "paragraph",
      text: "A thrown error anywhere in the pipeline becomes a `500` by default. Register your own handler to shape the response — return any `reply.*` value. See [Error handling](/docs/error-handling).",
    },
    {
      kind: "code",
      snippet: {
        filename: "errors.ts",
        language: "ts",
        code: `class NotFound extends Error {}

app.setErrorHandler((req, error) => {
  if (error instanceof NotFound) {
    return reply.json({ error: "not found" }, 404);
  }
  req.log.error("unhandled", { error: String(error) });
  return reply.json({ error: "internal" }, 500);
});

app.get("/items/:id", (req) => {
  if (req.params.id === "0") throw new NotFound();
  return reply.json({ id: req.params.id });
});`,
      },
    },
    { kind: "heading", id: "a-plugin", text: "Splitting routes into a plugin" },
    {
      kind: "paragraph",
      text: "A plugin is a function that receives a scope and registers routes/hooks on it. `app.register(plugin, { prefix })` mounts it under a path in its own encapsulated scope — hooks and decorators stay local to that subtree. This is how you keep a growing app organized. See [Plugins](/docs/plugins).",
    },
    {
      kind: "code",
      snippet: {
        filename: "plugin.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import type { TokiInstance } from "@usetoki/toki";

function users(app: TokiInstance) {
  app.get("/", () => reply.json([{ id: 1 }, { id: 2 }]));
  app.get("/:id", (req) => reply.json({ id: req.params.id }));
}

const app = createApp({ logger: "info" });
app.register(users, { prefix: "/users" }); // GET /users, GET /users/:id

app.listen(3000);`,
      },
    },
    { kind: "heading", id: "returning-responses", text: "Returning responses" },
    {
      kind: "paragraph",
      text: "A handler can return a `reply.*` value, a plain object (sent as JSON), or a string (sent as text). Returning a `Promise` keeps the request on the async path; everything else stays synchronous and fast. The `reply` builders cover the common shapes — see [Responses](/docs/response).",
    },
    {
      kind: "code",
      snippet: {
        filename: "responses.ts",
        language: "ts",
        code: `app.get("/text", () => "plain string");            // text/plain
app.get("/obj", () => ({ ok: true }));              // application/json
app.get("/made", () => reply.json({ id: 1 }, 201)); // explicit status
app.get("/html", () => reply.html("<h1>hi</h1>"));  // text/html
app.get("/go", () => reply.redirect("/text"));      // 302 Location
app.get("/gone", () => reply.empty(204));           // no body`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "`app.listen()` is synchronous — it binds the socket and returns once the server is accepting connections. There is no callback to wait for.",
    },
    { kind: "heading", id: "next", text: "Where to go next" },
    {
      kind: "list",
      items: [
        "[The application](/docs/application) — `createApp` options, `listen`, `register`, `decorate`, lifecycle.",
        "[Validation](/docs/validation) — schema-check the body, query, and params.",
        "[Server options](/docs/server-options) — timeouts, limits, rate limiting, TLS, unix sockets.",
        "[Testing](/docs/testing) — drive routes in-process with `app.inject`.",
      ],
    },
  ],
};
