import type { DocPage } from "../../types";

export const pluginsOverviewPage: DocPage = {
  slug: "plugins-overview",
  title: "Official plugins",
  description: "The 21 first-party packages that extend toki — security, sessions, HTTP, and infra.",
  blocks: [
    {
      kind: "paragraph",
      text: "Official plugins are separate npm packages that build on toki's public hook and middleware API — the same surface you'd use to write your own (see [Plugins & encapsulation](/docs/plugins)). They're pure TypeScript, depend on `@usetoki/toki` as a peer, and are versioned independently of the core. There are 21 of them, grouped below by what they do.",
    },
    { kind: "heading", id: "security-and-auth", text: "Security & auth" },
    {
      kind: "table",
      headers: ["Package", "What it does"],
      rows: [
        [
          "`@usetoki/toki-helmet`",
          "Secure HTTP response headers — CSP, HSTS, frameguard, and more",
        ],
        ["`@usetoki/toki-auth`", "Basic / bearer / API-key auth, composed with anyOf / allOf"],
        [
          "`@usetoki/toki-jwt`",
          "JWT sign + verify — HMAC (real secret required) or RS/PS/ES/EdDSA with remote JWKS",
        ],
        [
          "`@usetoki/toki-csrf`",
          "CSRF protection — signed double-submit tokens with origin checks",
        ],
        ["`@usetoki/toki-ip-filter`", "Allow / deny by IP and CIDR (IPv4 + IPv6)"],
      ],
    },
    { kind: "heading", id: "sessions-and-state", text: "Sessions, cookies & state" },
    {
      kind: "table",
      headers: ["Package", "What it does"],
      rows: [
        [
          "`@usetoki/toki-cookie`",
          "Signed + encrypted cookies (HMAC + AES-256-GCM) with key rotation",
        ],
        [
          "`@usetoki/toki-session`",
          "Stateful sessions with a pluggable store (memory, Redis, memcached)",
        ],
        [
          "`@usetoki/toki-secure-session`",
          "Stateless sessions sealed into an encrypted cookie — no store, ~4 KB cap",
        ],
        [
          "`@usetoki/toki-cache`",
          "Route response caching with TTL + Vary over memory, Redis, or memcached",
        ],
        [
          "`@usetoki/toki-idempotency`",
          "Idempotency-Key dedup / replay over memory, Redis, or memcached",
        ],
        [
          "`@usetoki/toki-ratelimiter`",
          "Per-route, per-key rate limiting with pluggable stores (memory, Redis, memcached)",
        ],
      ],
    },
    { kind: "heading", id: "http-features", text: "HTTP features" },
    {
      kind: "table",
      headers: ["Package", "What it does"],
      rows: [
        [
          "`@usetoki/toki-etag`",
          "Automatic ETag validators and 304 Not Modified for dynamic responses",
        ],
        ["`@usetoki/toki-range`", "HTTP Range / 206 partial content for buffers or files"],
        ["`@usetoki/toki-sse`", "Server-Sent Events with heartbeat and Last-Event-ID resume"],
        [
          "`@usetoki/toki-multipart-storage`",
          "Stream multipart uploads to disk, S3, or a custom store",
        ],
      ],
    },
    { kind: "heading", id: "infra-and-dx", text: "Infra & developer experience" },
    {
      kind: "table",
      headers: ["Package", "What it does"],
      rows: [
        [
          "`@usetoki/toki-env`",
          "Validate env vars at boot into a typed, frozen config — zero deps",
        ],
        ["`@usetoki/toki-sensible`", "HTTP errors, RFC 9457 problem+json, and assertions"],
        ["`@usetoki/toki-autoload`", "Filesystem routing from a directory tree"],
        ["`@usetoki/toki-view`", "Server-side templates (eta / ejs / handlebars)"],
        ["`@usetoki/toki-proxy`", "Reverse-proxy gateway with streaming pass-through"],
        ["`@usetoki/toki-circuit-breaker`", "Per-route circuit breaker, fast-fail 503"],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-cookie @usetoki/toki-session @usetoki/toki-auth @usetoki/toki-jwt`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "Most are plain middleware (`app.use` / a route `preHandler`). The session plugins wire a load + save hook, so you call them on a scope: `session(app, { secret })`.",
    },
  ],
};
