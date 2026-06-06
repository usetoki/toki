import type { DocPage } from "../../types";

export const circuitBreakerPluginPage: DocPage = {
  slug: "plugin-circuit-breaker",
  title: "Circuit breaker",
  description: "Per-route circuit breaker — fast-fail when a dependency is failing.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-circuit-breaker` wraps a handler so one sick dependency doesn't drag the whole route down with it. While the downstream is healthy the handler runs as normal. Once its failure rate over a rolling window crosses your threshold, the breaker opens and requests fast-fail with `503` and a `Retry-After` header — no more piling connections onto something that's already struggling. After a cooldown it lets a single probe through to decide whether to close again. Reach for it around any call that can fail or hang: an upstream HTTP service, a database, a third-party API.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-circuit-breaker`,
      },
    },
    {
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "`circuitBreaker(handler, options)` takes the handler to protect and returns a wrapped handler. A thrown error counts as a failure; everything else is a success.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { circuitBreaker } from "@usetoki/toki-circuit-breaker";

const app = createApp();

app.get(
  "/quote/:symbol",
  circuitBreaker(
    async (req) => {
      const q = await upstream.quote(req.params.symbol); // throws on upstream error
      return reply.json(q);
    },
    {
      failureThreshold: 0.5, // open at a 50% failure rate
      resetTimeoutMs: 30_000, // stay open 30s before probing
    },
  ),
);

app.listen(3000);`,
      },
    },
    {
      kind: "heading",
      id: "timeout",
      text: "Counting a slow call as a failure",
    },
    {
      kind: "paragraph",
      text: "A dependency that hangs is often worse than one that errors. Set `timeoutMs` so a handler that overruns counts as a failure and feeds the breaker.",
    },
    {
      kind: "code",
      snippet: {
        filename: "timeout.ts",
        language: "ts",
        code: `app.get("/profile/:id", circuitBreaker(
  async (req) => reply.json(await db.user(req.params.id)),
  {
    timeoutMs: 2000, // a call slower than 2s counts as a failure
    failureThreshold: 0.4,
    minimumRequests: 20, // don't judge until 20 calls in the window
  },
));`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`timeoutMs` makes the breaker move on, but it can't cancel the underlying call — the handler keeps running in the background. Use an `AbortSignal` inside your handler if you also need to stop the upstream work itself.",
    },
    {
      kind: "heading",
      id: "fallback",
      text: "Serving a degraded response",
    },
    {
      kind: "paragraph",
      text: "Without a `fallback`, an open breaker returns `503` and a failing call re-throws. Add a `fallback` to serve something useful instead — stale cache, a default, an empty list. It runs both when the breaker is open and when the wrapped call fails.",
    },
    {
      kind: "code",
      snippet: {
        filename: "fallback.ts",
        language: "ts",
        code: `app.get("/recommendations", circuitBreaker(
  async (req) => reply.json(await recoService.for(req.user.id)),
  {
    timeoutMs: 1500,
    fallback: () => reply.json({ items: [], degraded: true }),
  },
));`,
      },
    },
    {
      kind: "heading",
      id: "hooks",
      text: "Alerting on state changes",
    },
    {
      kind: "paragraph",
      text: "The `onOpen` / `onHalfOpen` / `onClose` hooks fire on each transition — wire them to logs or metrics so you see a dependency degrade in real time. A throw inside a hook can't corrupt the breaker; it's swallowed after the state has already changed.",
    },
    {
      kind: "code",
      snippet: {
        filename: "observability.ts",
        language: "ts",
        code: `const breaker = circuitBreaker(callPaymentsApi, {
  failureThreshold: 0.5,
  resetTimeoutMs: 15_000,
  onOpen: () => metrics.increment("payments.breaker.open"),
  onHalfOpen: () => log.info("payments breaker probing"),
  onClose: () => log.info("payments breaker recovered"),
});

app.post("/charge", breaker);`,
      },
    },
    {
      kind: "heading",
      id: "states",
      text: "How the states move",
    },
    {
      kind: "list",
      items: [
        "**closed** — calls run normally; outcomes are counted over a rolling `windowMs` window.",
        "Trips to **open** once `total >= minimumRequests` and the failure rate `>= failureThreshold`. The `minimumRequests` gate means a couple of early errors won't open it.",
        "**open** — every call fast-fails with `statusCode` (and `Retry-After`) until `resetTimeoutMs` elapses.",
        "**half-open** — one probe is let through; the rest still fast-fail. Probe succeeds → back to **closed**; probe fails → back to **open** for another cooldown.",
      ],
    },
    {
      kind: "heading",
      id: "options",
      text: "Options",
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Notes"],
      rows: [
        ["failureThreshold", "number (0–1)", "0.5", "Failure fraction over the window that trips the breaker."],
        ["minimumRequests", "number", "10", "Minimum calls in the window before it can trip."],
        ["windowMs", "number", "10000", "Rolling window for the failure rate."],
        ["resetTimeoutMs", "number", "30000", "How long to stay open before a probe."],
        ["timeoutMs", "number", "0 (off)", "A handler slower than this counts as a failure."],
        ["statusCode", "number", "503", "Status for a fast-failed request."],
        ["fallback", "(req) => HandlerResult | Promise<…>", "none", "Served when open or when the call fails, instead of `503`/re-throw."],
        ["onOpen / onHalfOpen / onClose", "() => void", "none", "Transition hooks for logging and metrics."],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Each `circuitBreaker(...)` call owns its own state, so the breaker is per-route. Pass a non-finite number to any numeric option and the constructor throws up front, rather than letting a `NaN` comparison silently keep the breaker from ever opening.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Pair it with `@usetoki/toki-proxy` at a gateway: wrap the proxy handler in a breaker so a dead upstream returns a fast `503` instead of leaking timeouts to every client.",
    },
  ],
};
