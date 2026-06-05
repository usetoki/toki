import type { DocPage } from "../../types";

export const middlewarePage: DocPage = {
  slug: "middleware",
  title: "Middleware",
  description: "Run logic before every handler in a scope with use().",
  blocks: [
    {
      kind: "paragraph",
      text: "`use(fn)` adds middleware that runs before every handler in the scope and its descendants — after `onRequest`/`preParsing` and before `preHandler`. A middleware that returns a `reply.*` value short-circuits the request.",
    },
    {
      kind: "code",
      snippet: {
        filename: "middleware.ts",
        language: "ts",
        code: `function requireApiKey(req) {
  if (req.headers.get("x-api-key") !== process.env.API_KEY) {
    return reply.json({ message: "unauthorized" }, 401);
  }
  // returning nothing continues to the next step
}

app.use(requireApiKey);
app.get("/secret", () => reply.text("ok"));`,
      },
    },
    { kind: "heading", id: "scoped", text: "Scoped middleware" },
    {
      kind: "paragraph",
      text: "Middleware registered on a [group](/docs/routing) or [plugin](/docs/plugins) only runs for routes in that scope, so you can protect a subtree without touching the rest of the app.",
    },
    {
      kind: "code",
      snippet: {
        filename: "scoped.ts",
        language: "ts",
        code: `app.group("/admin", (admin) => {
  admin.use(requireApiKey);
  admin.get("/stats", () => reply.json(stats));
});

app.get("/public", () => reply.text("open")); // not protected`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "Middleware and hooks both receive the request and may short-circuit. Use `use()` for app/route-tree logic and `addHook` when you need a specific lifecycle phase.",
    },
  ],
};
