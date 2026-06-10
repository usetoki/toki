import type { DocPage } from "../../types";

export const corsSecurityPage: DocPage = {
  slug: "cors-security",
  title: "CORS & security headers",
  description: "Enable CORS and baseline hardening headers with core middleware.",
  blocks: [
    {
      kind: "paragraph",
      text: "Browsers block cross-origin requests unless the server opts in with the right `Access-Control-*` headers. Toki ships that opt-in as core middleware, no plugin. `app.cors(options)` stages CORS headers on every response and answers preflight `OPTIONS` requests; `securityHeaders(options)` sets baseline hardening headers. Both work on the app or any scope/group.",
    },
    { kind: "heading", id: "cors", text: "CORS" },
    {
      kind: "paragraph",
      text: "`app.cors(options)` is the one-liner: it adds the `corsHeaders` middleware and registers a `corsPreflight` handler at `OPTIONS /*` on that scope. Call it once near the top so it applies to everything below.",
    },
    {
      kind: "code",
      snippet: {
        filename: "cors.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";

const app = createApp();

app.cors({
  origin: ["https://app.example"],
  methods: ["GET", "POST"],
  credentials: true,
});

app.get("/me", (req) => ({ ok: true }));
app.listen(3000);`,
      },
    },
    {
      kind: "heading",
      id: "cors-options",
      text: "CorsOptions",
    },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        [
          "`origin`",
          '`"*"`',
          'Allowed origin(s): `"*"`, a single origin string, a list, or a predicate `(origin) => boolean`.',
        ],
        [
          "`methods`",
          "`GET, POST, PUT, PATCH, DELETE, OPTIONS`",
          "Methods advertised in the preflight `Access-Control-Allow-Methods`.",
        ],
        [
          "`allowedHeaders`",
          "reflects request",
          "Preflight `Access-Control-Allow-Headers`. Omitted: echoes the client's `Access-Control-Request-Headers`, else `*`.",
        ],
        [
          "`exposedHeaders`",
          "—",
          "`Access-Control-Expose-Headers` — response headers JS is allowed to read.",
        ],
        [
          "`credentials`",
          "`false`",
          "Send `Access-Control-Allow-Credentials: true` so the browser includes cookies. Requires an explicit `origin`.",
        ],
        [
          "`maxAge`",
          "—",
          "`Access-Control-Max-Age` in seconds — how long a browser may cache the preflight.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: '`origin: "*"` together with `credentials: true` throws at setup: a wildcard that reflects any caller\'s cookies lets any site read authenticated responses. List the origins you trust instead. `Access-Control-Allow-Credentials` is only emitted alongside an allowed origin, never on its own.',
    },
    {
      kind: "heading",
      id: "cors-single",
      text: "Allow one origin",
    },
    {
      kind: "paragraph",
      text: "A single string pins the allow-origin to exactly that value for every request. No `Vary: Origin` is needed because the header never changes.",
    },
    {
      kind: "code",
      snippet: {
        filename: "single-origin.ts",
        language: "ts",
        code: `app.cors({ origin: "https://app.example" });
// Access-Control-Allow-Origin: https://app.example`,
      },
    },
    {
      kind: "heading",
      id: "cors-credentials",
      text: "Allow credentials",
    },
    {
      kind: "paragraph",
      text: "For cookie-bearing requests you must list real origins and set `credentials: true`. Toki reflects the matching origin and adds `Vary: Origin` so shared caches key on it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "credentials.ts",
        language: "ts",
        code: `app.cors({
  origin: ["https://app.example", "https://admin.example"],
  credentials: true,
  exposedHeaders: ["X-Request-Id"],
});`,
      },
    },
    {
      kind: "heading",
      id: "cors-dynamic",
      text: "Dynamic origin",
    },
    {
      kind: "paragraph",
      text: "Pass a predicate to allow a pattern, say any subdomain of a domain you own. It runs per request against the caller's `Origin`; return `true` to reflect it, `false` to omit the header.",
    },
    {
      kind: "code",
      snippet: {
        filename: "dynamic-origin.ts",
        language: "ts",
        code: `app.cors({
  origin: (origin) => /^https:\\/\\/[a-z0-9-]+\\.example\\.com$/.test(origin),
  credentials: true,
});`,
      },
    },
    {
      kind: "paragraph",
      text: "The lower-level pieces are exported if you want to wire them by hand: `corsHeaders(options)` is the response middleware and `corsPreflight(options)` is the `OPTIONS` handler. `app.cors` is just those two together.",
    },
    {
      kind: "code",
      snippet: {
        filename: "manual.ts",
        language: "ts",
        code: `import { corsHeaders, corsPreflight } from "@usetoki/toki";

const opts = { origin: ["https://app.example"], credentials: true };
app.use(corsHeaders(opts));
app.options("/api/*", corsPreflight(opts)); // only preflight the API`,
      },
    },
    { kind: "heading", id: "security-headers", text: "Security headers" },
    {
      kind: "paragraph",
      text: "`securityHeaders(options)` is a middleware that sets baseline hardening headers on every response in the scope. `X-Content-Type-Options: nosniff`, `X-Frame-Options`, and `Referrer-Policy` are always set; HSTS and CSP are opt-in.",
    },
    {
      kind: "code",
      snippet: {
        filename: "security.ts",
        language: "ts",
        code: `import { securityHeaders } from "@usetoki/toki";

app.use(
  securityHeaders({
    hsts: true,                  // Strict-Transport-Security, ~180d + includeSubDomains
    frameOptions: "DENY",        // X-Frame-Options
    referrerPolicy: "no-referrer",
    csp: "default-src 'self'",   // Content-Security-Policy
  }),
);`,
      },
    },
    {
      kind: "heading",
      id: "security-options",
      text: "SecurityOptions",
    },
    {
      kind: "table",
      headers: ["Option", "Default", "Sets"],
      rows: [
        ["`frameOptions`", '`"DENY"`', "`X-Frame-Options`."],
        ["`referrerPolicy`", '`"no-referrer"`', "`Referrer-Policy`."],
        [
          "`hsts`",
          "off",
          "`Strict-Transport-Security`. `true` ⇒ `max-age=15552000; includeSubDomains` (~180 days); a number is the max-age in seconds.",
        ],
        ["`csp`", "off", "`Content-Security-Policy` (verbatim)."],
      ],
    },
    {
      kind: "table",
      headers: ["Header", "Set when"],
      rows: [
        ["`X-Content-Type-Options: nosniff`", "Always."],
        ["`X-Frame-Options`", "Always (default `DENY`)."],
        ["`Referrer-Policy`", "Always (default `no-referrer`)."],
        ["`Strict-Transport-Security`", "`hsts` is set."],
        ["`Content-Security-Policy`", "`csp` is set."],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Enable `hsts` only once HTTPS is fully in place — it tells browsers to refuse plain HTTP to your host for the whole max-age, including subdomains. See [HTTPS / TLS](/docs/https) for terminating TLS in-process.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "Apply both on a scope or group to harden only part of the app. `app.cors` and `securityHeaders` follow the same scope inheritance as every other middleware. Pair with [JWT authentication](/docs/jwt) for credentialed APIs.",
    },
  ],
};
