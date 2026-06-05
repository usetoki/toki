import type { DocPage } from "../../types";

export const pluginsOverviewPage: DocPage = {
  slug: "plugins-overview",
  title: "Official plugins",
  description: "First-party packages that extend toki — secure headers and rate limiting.",
  blocks: [
    {
      kind: "paragraph",
      text: "Official plugins are separate npm packages that build on toki's public hook and middleware API — the same surface you'd use to write your own (see [Plugins & encapsulation](/docs/plugins)). They're pure TypeScript, depend on `@usetoki/toki` as a peer, and are versioned independently of the core.",
    },
    {
      kind: "table",
      headers: ["Package", "What it does"],
      rows: [
        [
          "`@usetoki/toki-helmet`",
          "Secure HTTP response headers — CSP, HSTS, frameguard, and more",
        ],
        [
          "`@usetoki/toki-ratelimiter`",
          "Per-route, per-key rate limiting with pluggable stores (memory, Redis, memcached)",
        ],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-helmet @usetoki/toki-ratelimiter`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "Each plugin is a plain middleware — use it app-wide with `app.use`, on a scope or group, or on a single route's `preHandler`. Nothing new to learn beyond the option objects.",
    },
  ],
};
