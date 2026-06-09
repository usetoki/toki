import type { DocPage } from "../../types";

export const helmetPluginPage: DocPage = {
  slug: "plugin-helmet",
  title: "Helmet",
  description: "Secure HTTP response headers for toki, in the spirit of helmet.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-helmet` stages a baseline of hardening headers on every response (CSP, HSTS, frameguard, `nosniff`, cross-origin policies, and more) from one middleware. Use it when you want the full helmet header set and real Content-Security-Policy control. Each header is individually configurable, overridable, or disablable, and the header set is computed once at construction, so per request it's a copy onto the response.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-helmet`,
      },
    },
    { kind: "heading", id: "quick-start", text: "Quick start" },
    {
      kind: "paragraph",
      text: "Call `helmet()` with no options for sensible defaults and `app.use` it. Use it app-wide, on a scope or group, or on a single route's `preHandler`. Staged headers ride along on error and not-found responses too.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { helmet } from "@usetoki/toki-helmet";

const app = createApp();

app.use(helmet());

app.get("/", () => "hello");
app.listen(3000);`,
      },
    },
    { kind: "heading", id: "defaults", text: "Defaults" },
    {
      kind: "table",
      headers: ["Header", "Default"],
      rows: [
        ["`Content-Security-Policy`", "helmet's baseline policy (see below)"],
        ["`Strict-Transport-Security`", "`max-age=15552000; includeSubDomains`"],
        ["`X-Frame-Options`", "`SAMEORIGIN`"],
        ["`X-Content-Type-Options`", "`nosniff`"],
        ["`Cross-Origin-Opener-Policy`", "`same-origin`"],
        ["`Cross-Origin-Resource-Policy`", "`same-origin`"],
        ["`Origin-Agent-Cluster`", "`?1`"],
        ["`Referrer-Policy`", "`no-referrer`"],
        ["`X-DNS-Prefetch-Control`", "`off`"],
        ["`X-Download-Options`", "`noopen`"],
        ["`X-Permitted-Cross-Domain-Policies`", "`none`"],
        ["`X-XSS-Protection`", "`0`"],
        ["`Cross-Origin-Embedder-Policy`", "off (opt in — it blocks cross-origin sub-resources)"],
      ],
    },
    {
      kind: "paragraph",
      text: "The default CSP locks everything to same-origin: `default-src 'self'`, `object-src 'none'`, `script-src 'self'`, `frame-ancestors 'self'`, `upgrade-insecure-requests`, plus `data:`/`https:` allowances for fonts, images, and styles.",
    },
    { kind: "heading", id: "configuring", text: "Configuring headers" },
    {
      kind: "paragraph",
      text: "For most headers: pass `false` to drop it, a string to override its value, or leave it out for the default. `contentSecurityPolicy` and `hsts` also accept a richer config object.",
    },
    {
      kind: "code",
      snippet: {
        filename: "helmet-config.ts",
        language: "ts",
        code: `app.use(
  helmet({
    hsts: { maxAge: 31536000, preload: true }, // 1 year + preload
    frameguard: "DENY",
    crossOriginEmbedderPolicy: true, // sets require-corp
    referrerPolicy: "strict-origin-when-cross-origin", // override the default value
    xssProtection: false, // drop the header entirely
  }),
);`,
      },
    },
    { kind: "heading", id: "csp", text: "Content-Security-Policy" },
    {
      kind: "paragraph",
      text: "By default a CSP config object merges over the baseline, so you only specify what changes. Directive keys are camelCase and emit kebab-case (`scriptSrc` → `script-src`). A list joins with spaces; `true` emits a bare directive like `upgrade-insecure-requests`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "csp-merge.ts",
        language: "ts",
        code: `// allow a CDN for scripts and an analytics endpoint, keep every other default
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", "https://cdn.example"],
        connectSrc: ["'self'", "https://analytics.example"],
      },
    },
  }),
);`,
      },
    },
    {
      kind: "paragraph",
      text: "Set `useDefaults: false` to start from an empty policy and declare every directive yourself — no baseline merge.",
    },
    {
      kind: "code",
      snippet: {
        filename: "csp-strict.ts",
        language: "ts",
        code: `app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: true,
      },
    },
  }),
);`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "`buildCsp` and `DEFAULT_CSP` are exported. Compose `DEFAULT_CSP` with your own directives and call `buildCsp(...)` to render a header string outside of helmet — handy for nonce-based policies generated per request.",
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default"],
      rows: [
        ["`contentSecurityPolicy`", "`false | { directives, useDefaults }`", "baseline policy"],
        ["`hsts`", "`false | { maxAge, includeSubDomains, preload }`", "`max-age=15552000; includeSubDomains`"],
        ["`frameguard`", "`false | \"DENY\" | \"SAMEORIGIN\"`", "`SAMEORIGIN`"],
        ["`crossOriginEmbedderPolicy`", "`boolean | string`", "off (`true` → `require-corp`)"],
        ["`crossOriginOpenerPolicy`", "`boolean | string`", "`same-origin`"],
        ["`crossOriginResourcePolicy`", "`boolean | string`", "`same-origin`"],
        ["`referrerPolicy`", "`boolean | string`", "`no-referrer`"],
        ["`originAgentCluster`", "`boolean`", "on (`?1`)"],
        ["`noSniff`", "`boolean`", "on (`nosniff`)"],
        ["`dnsPrefetchControl`", "`boolean | string`", "`off`"],
        ["`ieNoOpen`", "`boolean`", "on (`noopen`)"],
        ["`permittedCrossDomainPolicies`", "`boolean | string`", "`none`"],
        ["`xssProtection`", "`boolean`", "on (`0`)"],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`Cross-Origin-Embedder-Policy` is off by default on purpose. `require-corp` blocks cross-origin images, scripts, and fonts unless they send CORP/CORS headers. Turn it on only after you've confirmed every cross-origin sub-resource opts in, or the page breaks.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "`hsts.maxAge` must be a non-negative integer — a bad value throws at construction rather than emitting a header browsers silently reject. `X-XSS-Protection` is intentionally `0`: the legacy auditor it controls is itself exploitable, so the safe value disables it and you rely on CSP instead.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "toki ships a lighter `securityHeaders()` middleware in core for the essentials, see [CORS & security headers](/docs/cors-security). This plugin is the step up when you want the full helmet header set and CSP control.",
    },
  ],
};
