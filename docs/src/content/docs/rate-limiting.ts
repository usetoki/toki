import type { DocPage } from "../../types";

export const rateLimitingPage: DocPage = {
  slug: "rate-limiting",
  title: "Rate limiting",
  description: "A native per-IP limiter that answers 429 before a request reaches JS.",
  blocks: [
    {
      kind: "paragraph",
      text: "Pass `rateLimit` to `listen` to enable a native per-IP limiter. Over-limit requests get a `429 Too Many Requests` with a `Retry-After` header in native code — they never reach your handlers.",
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
    { kind: "heading", id: "how", text: "How it works" },
    {
      kind: "list",
      items: [
        "The limit is a fixed window: up to `max` requests per `windowMs` per client IP.",
        "Counting and the `429` response happen in Zig, so a flood costs almost nothing.",
        "Behind a proxy, the limiter sees the proxy's IP — terminate the limit at the edge, or set the limit accordingly.",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "For finer control (per-route limits, custom keys), implement a middleware. The native limiter is the cheap, global first line of defense.",
    },
  ],
};
