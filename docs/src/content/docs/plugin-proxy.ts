import type { DocPage } from "../../types";

export const proxyPluginPage: DocPage = {
  slug: "plugin-proxy",
  title: "Proxy",
  description: "Reverse-proxy gateway with streaming pass-through to an upstream.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-proxy` forwards a request to an upstream service and streams the response straight back, so even a large upstream body is never buffered in the gateway. Hop-by-hop headers are stripped, the `X-Forwarded-*` chain is set, and a request that can't reach the upstream becomes a `502`.",
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
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { proxy } from "@usetoki/toki-proxy";

const app = createApp();

// forward /api/* to an internal service, stripping the /api prefix
app.get("/api/*", proxy({ upstream: "http://internal:9000", rewritePath: (p) => p.slice(4) }));
app.post("/api/*", proxy({ upstream: "http://internal:9000", rewritePath: (p) => p.slice(4) }));`,
      },
    },
    {
      kind: "list",
      items: [
        "`upstream` — the base URL. A crafted request path can't redirect the proxy off this origin.",
        "`rewritePath(path)` — map the incoming path to the upstream path; query strings are preserved.",
        "`headers` / `stripHeaders` — add or drop request headers before forwarding.",
        "`timeoutMs` — abort a slow upstream. `trustProxy` — append to an inbound `X-Forwarded-For` (off by default, so clients can't forge the chain).",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Compose it with other plugins — put `circuitBreaker`, `cache`, or `ipFilter` in front of a proxy route to add resilience, caching, or access control at the gateway.",
    },
  ],
};
