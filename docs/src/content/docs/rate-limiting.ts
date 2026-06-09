import type { DocPage } from "../../types";

export const rateLimitingPage: DocPage = {
  slug: "rate-limiting",
  title: "Rate limiting",
  description: "A native per-IP limiter that answers 429 before a request reaches JS.",
  blocks: [
    {
      kind: "paragraph",
      text: "Pass `rateLimit` to `listen` to enable the built-in per-IP limiter. It runs in Zig: over-limit requests get a `429 Too Many Requests` with a `Retry-After` header before they ever reach your handlers, so a flood costs almost nothing. This is core; no plugin needed.",
    },
    {
      kind: "code",
      snippet: {
        filename: "rate-limit.ts",
        language: "ts",
        code: `app.listen(3000, {
  rateLimit: { max: 100, windowMs: 60_000 }, // 100 requests / minute / IP
});`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Field", "Type", "Description"],
      rows: [
        ["`max`", "`number`", "Requests allowed per window, per client IP."],
        ["`windowMs`", "`number`", "Window length in milliseconds."],
      ],
    },
    { kind: "heading", id: "how", text: "How it works" },
    {
      kind: "list",
      items: [
        "Fixed window: up to `max` requests per `windowMs` per client IP. The window resets as a block, not as a sliding average.",
        "Counting and the `429` response happen in native code, so the event loop never sees a rejected request.",
        "The key is the peer IP. Behind a proxy the limiter sees the proxy's IP, so terminate the limit at the edge, or raise `max` to fit your fan-out.",
        "Unix-domain sockets have no peer IP (`req.ip` is empty), so the native limiter cannot key on the caller — limit at the proxy instead.",
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "One IP can mean many users behind NAT or a corporate gateway, and one user can rotate IPs. The native limiter is a cheap, global flood guard, not per-account quota. For per-user or per-key limits, use a middleware (below).",
    },
    { kind: "heading", id: "custom-key", text: "Per-key limits in middleware" },
    {
      kind: "paragraph",
      text: "When you need a custom key (an API key, a user id) or per-route limits, write a middleware. A middleware that returns a response short-circuits the request, so return `reply.json(..., 429)` to reject. This runs in JS, so reserve it for the routes that need it; keep the native limiter as the outer flood guard.",
    },
    {
      kind: "code",
      snippet: {
        filename: "key-limit.ts",
        language: "ts",
        code: `import { reply, type Middleware } from "@usetoki/toki";

// fixed-window counter keyed by anything you choose
function rateLimit(opts: { max: number; windowMs: number; key: (req: any) => string }): Middleware {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req) => {
    const now = Date.now();
    const k = opts.key(req);
    const slot = hits.get(k);
    if (!slot || now >= slot.resetAt) {
      hits.set(k, { count: 1, resetAt: now + opts.windowMs });
      return;
    }
    if (slot.count >= opts.max) {
      const retryAfter = Math.ceil((slot.resetAt - now) / 1000);
      req.setResponseHeader("Retry-After", String(retryAfter));
      return reply.json({ error: "rate limited" }, 429);
    }
    slot.count++;
  };
}

app.group("/api", (api) => {
  api.use(
    rateLimit({
      max: 30,
      windowMs: 60_000,
      key: (req) => req.headers.get("x-api-key") ?? req.ip,
    }),
  );
  api.get("/search", (req) => ({ results: [] }));
});`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "The `Map` above lives in one process. With `reusePort` or multiple workers each has its own counter, so the effective limit multiplies by the worker count. For a shared limit across processes, back the counter with a store (e.g. Redis) — see the [Redis plugin](/docs/plugin-redis).",
    },
    { kind: "heading", id: "custom-429", text: "Custom 429 response" },
    {
      kind: "paragraph",
      text: "The native limiter's `429` is fixed. To shape the body or add headers (e.g. `RateLimit-*`), do the limiting in the middleware above and return whatever response you like.",
    },
    {
      kind: "code",
      snippet: {
        filename: "custom-429.ts",
        language: "ts",
        code: `import { reply } from "@usetoki/toki";

return reply.json(
  { statusCode: 429, error: "Too Many Requests", message: "slow down" },
  429,
);`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Combine both layers: the native `rateLimit` on `listen` as a cheap blanket flood guard, plus a targeted middleware on the expensive or abuse-prone routes. See [Server options](/docs/server-options) for where `rateLimit` sits among the other listen tunables.",
    },
  ],
};
