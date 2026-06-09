import type { DocPage } from "../../types";

export const proxyPluginPage: DocPage = {
  slug: "plugin-proxy",
  title: "Proxy",
  description: "Reverse-proxy gateway that streams a request straight through to an upstream.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-proxy` turns a route into a reverse proxy. It forwards the request to an upstream service and streams the response body straight back. Nothing is buffered in the gateway, so a 2 GB download costs the same memory as a 2 KB one. Hop-by-hop headers are stripped on both legs, the `X-Forwarded-*` chain is set from the real peer, and an upstream that's unreachable or too slow becomes a clean `502`. Use it when toki is the edge in front of internal services, or to add caching, rate limiting, or a circuit breaker at the gateway without touching the upstream.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-proxy`,
      },
    },
    {
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "`proxy(options)` returns a normal handler. Mount it on whatever methods and path you want forwarded — a catch-all (`/api/*`) is the common case for a gateway.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { proxy } from "@usetoki/toki-proxy";

const app = createApp();

// forward /api/* to an internal service, stripping the /api prefix
const gateway = proxy({
  upstream: "http://internal:9000",
  rewritePath: (p) => p.slice(4), // /api/users -> /users
});

app.get("/api/*", gateway);
app.post("/api/*", gateway);
app.put("/api/*", gateway);
app.delete("/api/*", gateway);

app.listen(3000);`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "The query string rides along automatically: `/api/users?page=2` arrives at the upstream as `/users?page=2`. `rewritePath` only sees the path, never the query.",
    },
    {
      kind: "heading",
      id: "headers",
      text: "Adding and stripping headers",
    },
    {
      kind: "paragraph",
      text: "Inject a service token on the way out and drop a header you don't want the upstream to see. Both run after hop-by-hop stripping, so you only deal with real application headers.",
    },
    {
      kind: "code",
      snippet: {
        filename: "internal-gateway.ts",
        language: "ts",
        code: `app.all("/internal/*", proxy({
  upstream: "http://orders:8080",
  rewritePath: (p) => p.slice(9),
  headers: { "x-service-token": process.env.ORDERS_TOKEN! }, // added to every request
  stripHeaders: ["cookie", "authorization"], // never reaches the upstream
}));`,
      },
    },
    {
      kind: "heading",
      id: "timeout",
      text: "Timeouts and slow upstreams",
    },
    {
      kind: "paragraph",
      text: "`timeoutMs` aborts the upstream call (the abort also covers a stalled response stream). On abort or any connection error the client gets a `502 Bad Gateway`, never a hung request.",
    },
    {
      kind: "code",
      snippet: {
        filename: "timeout.ts",
        language: "ts",
        code: `app.get("/search/*", proxy({
  upstream: "http://search:9200",
  rewritePath: (p) => p.slice(7),
  timeoutMs: 3000, // abort + 502 if the upstream hasn't answered in 3s
}));`,
      },
    },
    {
      kind: "heading",
      id: "behind-a-proxy",
      text: "Running behind a trusted proxy",
    },
    {
      kind: "paragraph",
      text: "By default the gateway is treated as the edge: any inbound `X-Forwarded-For` is overwritten with the real peer IP, and `X-Forwarded-Proto` is reported as `http`, so a client can't forge the chain. If toki sits behind a load balancer you control, set `trustProxy: true` to append to the existing chain and honor the inbound protocol instead.",
    },
    {
      kind: "code",
      snippet: {
        filename: "behind-lb.ts",
        language: "ts",
        code: `app.all("/*", proxy({
  upstream: "http://app:8080",
  trustProxy: true, // we're behind an LB that already set X-Forwarded-For/-Proto
}));`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Only set `trustProxy: true` when something you trust sits in front of toki. At the edge it lets any client spoof their source IP and protocol through `X-Forwarded-For` / `X-Forwarded-Proto`.",
    },
    {
      kind: "heading",
      id: "compose",
      text: "Composing with other plugins",
    },
    {
      kind: "paragraph",
      text: "A proxy handler is just a handler, so the usual hooks and plugins stack in front of it. Add a circuit breaker so a failing upstream fast-fails instead of piling up, and rate limiting so one client can't saturate the gateway.",
    },
    {
      kind: "code",
      snippet: {
        filename: "resilient-gateway.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { proxy } from "@usetoki/toki-proxy";
import { circuitBreaker } from "@usetoki/toki-circuit-breaker";
import { rateLimiter } from "@usetoki/toki-ratelimiter";

const app = createApp();

const forward = proxy({
  upstream: "http://payments:9000",
  rewritePath: (p) => p.slice(9),
  timeoutMs: 2000,
});

app.register(rateLimiter({ max: 100, windowMs: 60_000 }));
app.post("/payments/*", circuitBreaker(forward, { failureThreshold: 0.5 }));`,
      },
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
        ["upstream", "string", "(required)", "Upstream base URL, e.g. `http://internal:9000`. A crafted path can't redirect the proxy off this origin."],
        ["rewritePath", "(path: string) => string", "forward unchanged", "Map the incoming path to the upstream path. Query string is preserved separately."],
        ["headers", "Record<string, string>", "none", "Headers added to every forwarded request."],
        ["stripHeaders", "string[]", "none", "Request headers to drop before forwarding (case-insensitive)."],
        ["trustProxy", "boolean", "false", "Append to an inbound `X-Forwarded-For` and honor `X-Forwarded-Proto`. Off = overwrite with the real peer."],
        ["timeoutMs", "number", "none", "Abort the upstream call after this many ms, then return `502`."],
        ["fetch", "typeof fetch", "global fetch", "Inject a custom `fetch` (custom agent, mTLS, tests)."],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The proxy pins every request to `upstream`'s origin. A rewritten path that resolves off-origin (`//evil.com/x`, an absolute URL) is rejected with `502`, so a `rewritePath` mistake fails closed rather than forwarding to an attacker.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "Hop-by-hop headers (`Connection`, `Transfer-Encoding`, `Keep-Alive`, `Upgrade`, …) and `Host`/`Content-Length` are stripped on both legs and re-derived by the upstream client. `Set-Cookie` is replayed per-value, so multiple cookies survive intact.",
    },
  ],
};
