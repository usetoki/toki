import type { DocPage } from "../../types";

export const decoratorsPage: DocPage = {
  slug: "decorators",
  title: "Decorators",
  description: "Attach shared values to the app or to every request.",
  blocks: [
    {
      kind: "paragraph",
      text: "Decorators attach reusable values without reaching for module globals. `decorate` adds an app-global property; `decorateRequest` adds a property to every request handled in a scope.",
    },
    { kind: "heading", id: "app", text: "App decorators" },
    {
      kind: "paragraph",
      text: "`app.decorate(name, value)` is app-global — useful for shared services like a database client or config.",
    },
    {
      kind: "code",
      snippet: {
        filename: "decorate.ts",
        language: "ts",
        code: `app.decorate("db", database);

app.get("/users", (req) => {
  // reachable via the app instance
  return reply.json(app.db.listUsers());
});`,
      },
    },
    { kind: "heading", id: "request", text: "Request decorators" },
    {
      kind: "paragraph",
      text: "`decorateRequest(name, value)` attaches a property to every request in the scope. It is scoped — a plugin's request decorations stay within that plugin.",
    },
    {
      kind: "code",
      snippet: {
        filename: "decorate-request.ts",
        language: "ts",
        code: `app.decorateRequest("startedAt", 0);

app.addHook("onRequest", (req) => {
  (req as { startedAt: number }).startedAt = performance.now();
});

app.addHook("onResponse", (req) => {
  const ms = performance.now() - (req as { startedAt: number }).startedAt;
  req.log.info("served", { ms });
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Decorating with a default value keeps the request object's shape stable, which helps V8 keep your handlers fast.",
    },
  ],
};
