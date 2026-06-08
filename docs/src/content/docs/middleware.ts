import type { DocPage } from "../../types";

export const middlewarePage: DocPage = {
  slug: "middleware",
  title: "Middleware",
  description: "Run logic before every handler in a scope with use().",
  blocks: [
    {
      kind: "paragraph",
      text: "Middleware is a function that runs before every handler in a scope. `use(fn)` registers it; the function receives the request and may return a `reply.*` value to short-circuit (the handler and remaining middleware are skipped) or return nothing to continue. It's the simplest way to add auth, headers, or logging to a whole route tree.",
    },
    {
      kind: "code",
      snippet: {
        filename: "signature.ts",
        language: "ts",
        code: `import type { Middleware } from "@usetoki/toki";

// (req) => HandlerResult | void | Promise<HandlerResult | void>
const tag: Middleware = (req) => {
  req.setResponseHeader("X-Served-By", "toki");
  // returning nothing continues to the next step
};

app.use(tag);`,
      },
    },
    { kind: "heading", id: "order", text: "Where middleware runs" },
    {
      kind: "paragraph",
      text: "Middleware sits in the request lifecycle between the early hooks and the handler — after `onRequest` and `preParsing`, before `preValidation`, the route schema, and `preHandler`. Within a scope, middleware runs in registration order; across scopes, outer before inner.",
    },
    {
      kind: "table",
      headers: ["Step", "What it is"],
      rows: [
        ["`onRequest`, `preParsing`", "early hooks"],
        ["**`use()` middleware**", "this scope, then group middleware"],
        ["`preValidation` → schema", "validation"],
        ["`preHandler`", "last hook before the handler"],
        ["handler", "your route"],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Middleware and `preHandler` hooks have the same signature and both can short-circuit. Use `use()` for broad route-tree logic; reach for `addHook(\"preHandler\", ...)` (see [Hooks](/docs/hooks)) when you need to run after validation, or for a single route via its `preHandler` option.",
    },
    { kind: "heading", id: "guard", text: "A guard" },
    {
      kind: "paragraph",
      text: "Return a `reply` to reject; return nothing to allow. Because the return value flows straight into the response, a guard needs no `next` callback.",
    },
    {
      kind: "code",
      snippet: {
        filename: "guard.ts",
        language: "ts",
        code: `import { reply } from "@usetoki/toki";

function requireApiKey(req) {
  if (req.headers.get("x-api-key") !== process.env.API_KEY) {
    return reply.json({ message: "unauthorized" }, 401); // short-circuit
  }
}

app.use(requireApiKey);
app.get("/secret", () => reply.text("ok"));`,
      },
    },
    { kind: "heading", id: "logger", text: "A logging middleware" },
    {
      kind: "paragraph",
      text: "Middleware runs before the handler, so it can only time the inbound leg directly; for full request timing add an `onResponse` hook (see [Hooks](/docs/hooks)). Here middleware records the start and logs the method and path.",
    },
    {
      kind: "code",
      snippet: {
        filename: "logger.ts",
        language: "ts",
        code: `app.use((req) => {
  (req as any).startedAt = performance.now();
  req.log.info("request", { method: req.method, path: req.path, ip: req.ip });
});

app.addHook("onResponse", (req, res) => {
  const ms = performance.now() - (req as any).startedAt;
  req.log.info("response", { status: res.status, ms: Math.round(ms) });
});`,
      },
    },
    { kind: "heading", id: "compose", text: "Composing several" },
    {
      kind: "paragraph",
      text: "Call `use()` more than once to stack middleware; they run in the order registered. Several first-party helpers — `securityHeaders()`, `corsHeaders()` — are just middleware factories you stack the same way.",
    },
    {
      kind: "code",
      snippet: {
        filename: "compose.ts",
        language: "ts",
        code: `import { securityHeaders, corsHeaders, reply } from "@usetoki/toki";

app.use(securityHeaders({ hsts: true }));
app.use(corsHeaders({ origin: "https://app.example.com" }));
app.use((req) => {
  req.log.debug("after headers + cors", { path: req.path });
});

app.get("/", () => reply.text("ok"));`,
      },
    },
    { kind: "heading", id: "scoped", text: "Scoped middleware" },
    {
      kind: "paragraph",
      text: "Middleware registered on a [group](/docs/routing) or [plugin](/docs/plugins) runs only for routes in that scope, so you can protect a subtree without touching the rest of the app. Group middleware runs after the scope's own `use()` middleware.",
    },
    {
      kind: "code",
      snippet: {
        filename: "scoped.ts",
        language: "ts",
        code: `import { reply } from "@usetoki/toki";

app.group("/admin", (admin) => {
  admin.use(requireApiKey);
  admin.get("/stats", () => reply.json(stats));
});

// a plugin scope works the same way
app.register((billing) => {
  billing.use(requireApiKey);
  billing.get("/invoices", () => reply.json(invoices));
}, { prefix: "/billing" });

app.get("/public", () => reply.text("open")); // not protected`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Async middleware is supported, but the request buffer is engine-owned and valid only during the synchronous part of the call. Read `req.body` / `req.text()` before the first `await`.",
    },
  ],
};
