import type { DocPage } from "../../types";

export const corsSecurityPage: DocPage = {
  slug: "cors-security",
  title: "CORS & security headers",
  description: "Enable CORS and baseline hardening headers.",
  blocks: [
    {
      kind: "paragraph",
      text: "`cors(options)` stages the right CORS headers on every response and answers preflight `OPTIONS` requests. Call it on the app or a scope.",
    },
    {
      kind: "code",
      snippet: {
        filename: "cors.ts",
        language: "ts",
        code: `import { cors } from "@usetoki/toki";

app.cors({
  origin: ["https://app.example"],
  methods: ["GET", "POST"],
  credentials: true,
});`,
      },
    },
    {
      kind: "paragraph",
      text: "The lower-level `corsHeaders(options)` (a middleware) and `corsPreflight(options)` (an `OPTIONS` handler) are exported if you want to wire them yourself.",
    },
    { kind: "heading", id: "security-headers", text: "Security headers" },
    {
      kind: "paragraph",
      text: "`securityHeaders(options)` is a middleware that sets baseline hardening headers on every response.",
    },
    {
      kind: "code",
      snippet: {
        filename: "security.ts",
        language: "ts",
        code: `import { securityHeaders } from "@usetoki/toki";

app.use(
  securityHeaders({
    hsts: true,                  // Strict-Transport-Security
    frameOptions: "DENY",        // X-Frame-Options
    referrerPolicy: "no-referrer",
    csp: "default-src 'self'",   // Content-Security-Policy
  }),
);`,
      },
    },
    {
      kind: "table",
      headers: ["Header", "Set by"],
      rows: [
        ["`X-Content-Type-Options: nosniff`", "Always"],
        ["`X-Frame-Options`", "`frameOptions` (default `DENY`)"],
        ["`Referrer-Policy`", "`referrerPolicy` (default `no-referrer`)"],
        ["`Strict-Transport-Security`", "`hsts`"],
        ["`Content-Security-Policy`", "`csp`"],
      ],
    },
  ],
};
