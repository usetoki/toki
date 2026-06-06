import type { DocPage } from "../../types";

export const circuitBreakerPluginPage: DocPage = {
  slug: "plugin-circuit-breaker",
  title: "Circuit breaker",
  description: "Per-route circuit breaker — fast-fail 503 when a dependency is failing.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-circuit-breaker` wraps a handler so a failing dependency stops taking the whole route down with it. While the downstream is healthy the handler runs normally; once its failure rate trips the breaker, requests fast-fail with `503` (and `Retry-After`) until a single probe finds it recovered.",
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
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { circuitBreaker } from "@usetoki/toki-circuit-breaker";

const app = createApp();

app.get(
  "/quote/:symbol",
  circuitBreaker((req) => upstream.quote(req.params.symbol), {
    timeoutMs: 2000, // a call slower than this counts as a failure
    failureThreshold: 0.5, // open at a 50% failure rate
    resetTimeoutMs: 30_000, // wait this long before probing
    fallback: () => reply.json({ stale: true }), // serve degraded instead of erroring
  }),
);`,
      },
    },
    {
      kind: "list",
      items: [
        "Opens on the failure *rate* over a rolling window, with a `minimumRequests` gate so a couple of early errors don't trip it.",
        "A thrown error — or a handler that overruns `timeoutMs` — counts as a failure.",
        "While open, requests fast-fail `503`; after `resetTimeoutMs` a single probe decides whether to close or re-open.",
        "`fallback` serves a degraded response instead of an error; `onOpen` / `onClose` hooks let you alert.",
      ],
    },
  ],
};
