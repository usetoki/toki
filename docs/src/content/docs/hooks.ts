import type { DocPage } from "../../types";

export const hooksPage: DocPage = {
  slug: "hooks",
  title: "Hooks & lifecycle",
  description: "The request lifecycle and the hooks you can tap at each phase.",
  blocks: [
    {
      kind: "paragraph",
      text: "A hook runs at a fixed point around a handler. Register one with `addHook(name, fn)` on the app or any scope. Hooks let you add cross-cutting behaviour (auth, timing, header injection, response rewriting) without touching the handler. Each hook is scoped: it runs only for routes in the scope that registered it, and outer scopes run before inner ones.",
    },
    {
      kind: "paragraph",
      text: "Hooks come in three shapes. `onRequest`, `preParsing`, `preValidation`, and `preHandler` receive the request and may *short-circuit* by returning a `reply.*` value; the handler and remaining steps are then skipped. `preSerialization` receives a plain return value and returns the payload to encode. `onResponse` and `onSend` receive the built response and may return a replacement.",
    },
    { kind: "heading", id: "order", text: "Execution order" },
    {
      kind: "paragraph",
      text: "Every phase runs in registration order, outer scope before inner. `use()` middleware and group middleware slot in between `preParsing` and `preValidation` — see [Middleware](/docs/middleware).",
    },
    {
      kind: "table",
      headers: ["Hook", "Runs", "Can short-circuit", "Signature"],
      rows: [
        ["`onRequest`", "First, before the body is touched", "Yes", "`(req) => reply? `"],
        ["`preParsing`", "Before the body is read", "Yes", "`(req) => reply?`"],
        ["`preValidation`", "Before the route schema runs", "Yes", "`(req) => reply?`"],
        ["`preHandler`", "Right before the handler", "Yes", "`(req) => reply?`"],
        ["`preSerialization`", "On a plain return value, before JSON encoding", "Transforms it", "`(req, payload) => payload`"],
        ["`onResponse`", "After the response is built", "Replaces it", "`(req, res) => res?`"],
        ["`onSend`", "Last, just before the bytes go out", "Replaces it", "`(req, res) => res?`"],
        ["`onTimeout`", "When a handler exceeds `requestTimeoutMs`", "No", "`(req) => void`"],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "`onResponse` runs before `onSend`, not after. Both see the built response, so order them by what each needs to read or rewrite. `preSerialization` only fires for plain values bound for JSON; a `reply.text(...)` or a built `reply` skips it.",
    },
    { kind: "heading", id: "basics", text: "Tapping the lifecycle" },
    {
      kind: "paragraph",
      text: "A typical app logs on the way in, authenticates just before the handler, and records timing on the way out. `req.log` is the app logger (see [Logging](/docs/logging)); bind `req.id` with a child logger when you want every line correlated.",
    },
    {
      kind: "code",
      snippet: {
        filename: "hooks.ts",
        language: "ts",
        code: `import { reply } from "@usetoki/toki";

app.addHook("onRequest", (req) => {
  req.log.info("incoming", { method: req.method, path: req.path });
});

app.addHook("preHandler", (req) => {
  if (!req.headers.get("authorization")) {
    return reply.json({ message: "unauthorized" }, 401); // short-circuit
  }
});

app.addHook("onResponse", (req, res) => {
  req.log.info("done", { status: res.status });
});`,
      },
    },
    { kind: "heading", id: "auth", text: "Auth in a preHandler" },
    {
      kind: "paragraph",
      text: "Authenticate in `preHandler` so it runs after parsing and validation but before the handler. Returning a `reply` stops the request; returning nothing lets it through. Stash the result on the request with a decorator so the handler can read it — see [Decorators](/docs/decorators).",
    },
    {
      kind: "code",
      snippet: {
        filename: "auth.ts",
        language: "ts",
        code: `import { reply, verifyJwt } from "@usetoki/toki";

app.decorateRequest("user", null);

app.addHook("preHandler", async (req) => {
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return reply.json({ message: "missing token" }, 401);
  try {
    (req as any).user = await verifyJwt(token, process.env.JWT_SECRET!);
  } catch {
    return reply.json({ message: "invalid token" }, 401);
  }
});

app.get("/me", (req) => reply.json({ id: (req as any).user.sub }));`,
      },
    },
    { kind: "heading", id: "timing", text: "Timing with onResponse" },
    {
      kind: "paragraph",
      text: "Stash a start time on the request in `onRequest`, then read it back in `onResponse`. Both run on the same `req`, so a plain property is enough.",
    },
    {
      kind: "code",
      snippet: {
        filename: "timing.ts",
        language: "ts",
        code: `app.addHook("onRequest", (req) => {
  (req as any).startedAt = performance.now();
});

app.addHook("onResponse", (req, res) => {
  const ms = performance.now() - (req as any).startedAt;
  req.log.info("served", { path: req.path, status: res.status, ms: Math.round(ms) });
});`,
      },
    },
    { kind: "heading", id: "transforming", text: "Transforming the response" },
    {
      kind: "paragraph",
      text: "`preSerialization` sees the plain value a handler returned (before it becomes a response) and returns the value to encode. `onSend` sees the built response — status, content type, body, headers — and may return a replacement built with `reply.*`. To add a header without rebuilding the body, stage it earlier with `req.setResponseHeader`; staged headers merge onto the outgoing response.",
    },
    {
      kind: "code",
      snippet: {
        filename: "transform.ts",
        language: "ts",
        code: `import { reply } from "@usetoki/toki";

// stamp a request id on every response — staged early, merged on the way out
app.addHook("onRequest", (req) => {
  req.setResponseHeader("X-Request-Id", req.id);
});

// strip internal fields from every JSON payload in this scope
app.addHook("preSerialization", (req, payload) => {
  if (payload && typeof payload === "object" && "passwordHash" in payload) {
    const { passwordHash, ...safe } = payload as Record<string, unknown>;
    return safe;
  }
  return payload;
});

// replace the whole response from onSend when you need to rewrite the body
app.addHook("onSend", (req, res) => {
  if (res.status === 404) return reply.json({ error: "not found" }, 404);
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "`compression()` is just an `onSend` hook. `app.addHook(\"onSend\", compression())` brotli/gzip-encodes text responses off the event loop per `Accept-Encoding`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "compress.ts",
        language: "ts",
        code: `import { compression } from "@usetoki/toki";

app.addHook("onSend", compression({ threshold: 1024 }));`,
      },
    },
    { kind: "heading", id: "scoping", text: "Scoping hooks" },
    {
      kind: "paragraph",
      text: "A hook added on a [plugin](/docs/plugins) or child scope runs only for that scope's routes. This is how you protect a subtree without touching the rest of the app: register the auth hook on the encapsulated instance, not the root.",
    },
    {
      kind: "code",
      snippet: {
        filename: "scoped.ts",
        language: "ts",
        code: `import { reply } from "@usetoki/toki";

app.register((admin) => {
  admin.addHook("preHandler", (req) => {
    if (req.headers.get("x-admin-key") !== process.env.ADMIN_KEY) {
      return reply.empty(403);
    }
  });
  admin.get("/stats", () => reply.json(stats));
}, { prefix: "/admin" });

app.get("/public", () => reply.text("open")); // hook never runs here`,
      },
    },
    { kind: "heading", id: "errors", text: "Errors and timeouts" },
    {
      kind: "paragraph",
      text: "A throw anywhere in the chain — hook or handler — routes to the nearest scope's error handler, set with `onError` (alias `setErrorHandler`). With `requestTimeoutMs` configured, a slow async handler triggers `onTimeout` hooks and the engine replies `408`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "errors.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp({ logger: "info", requestTimeoutMs: 5000 });

app.onError((req, error) => {
  req.log.error("handler failed", { path: req.path, error: String(error) });
  return reply.json({ message: "internal error" }, 500);
});

app.addHook("onTimeout", (req) => {
  req.log.warn("request timed out", { path: req.path });
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The request buffer is engine-owned and valid only during the synchronous part of a hook. Read `req.body` / `req.text()` before the first `await`. Async short-circuits are fine; capture what you need up front.",
    },
  ],
};
