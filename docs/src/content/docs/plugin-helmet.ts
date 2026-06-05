import type { DocPage } from "../../types";

export const helmetPluginPage: DocPage = {
  slug: "plugin-helmet",
  title: "Helmet",
  description: "Secure HTTP response headers for toki, in the spirit of helmet.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-helmet` sets a baseline of hardening headers — CSP, HSTS, frameguard, `nosniff`, cross-origin policies, and more — from a single middleware. Each header is individually configurable or disablable.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-helmet`,
      },
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
    {
      kind: "paragraph",
      text: "Use it app-wide, on a scope or group, or on a single route's `preHandler`. Staged headers ride along on error and not-found responses too.",
    },
    { kind: "heading", id: "defaults", text: "Defaults" },
    {
      kind: "table",
      headers: ["Header", "Default"],
      rows: [
        ["`Content-Security-Policy`", "helmet's baseline policy"],
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
    { kind: "heading", id: "configuring", text: "Configuring" },
    {
      kind: "paragraph",
      text: "Pass `false` to drop a header, a string to override its value, or a config object for `contentSecurityPolicy` and `hsts`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "helmet-config.ts",
        language: "ts",
        code: `app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { scriptSrc: ["'self'", "https://cdn.example"] }, // merges over defaults
    },
    hsts: { maxAge: 31536000, preload: true },
    frameguard: "DENY",
    crossOriginEmbedderPolicy: true, // require-corp
    referrerPolicy: "strict-origin-when-cross-origin",
    xssProtection: false, // drop the header
  }),
);`,
      },
    },
    {
      kind: "list",
      items: [
        "`contentSecurityPolicy: { useDefaults: false, directives: {…} }` starts from an empty policy instead of merging over the defaults.",
        "`buildCsp` and the `DEFAULT_CSP` directives are exported if you want to compose a policy yourself.",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "toki ships a lighter `securityHeaders()` middleware in core for the essentials — see [CORS & security headers](/docs/cors-security). Reach for this plugin when you want the full helmet header set and CSP control.",
    },
  ],
};
