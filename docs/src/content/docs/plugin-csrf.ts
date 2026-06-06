import type { DocPage } from "../../types";

export const csrfPluginPage: DocPage = {
  slug: "plugin-csrf",
  title: "CSRF",
  description: "CSRF protection — signed double-submit tokens with optional origin checks.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-csrf` protects state-changing requests with a signed double-submit token. `req.csrfToken()` mints a random token, signs it into an `HttpOnly` cookie, and returns the raw value for the page to send back. On every unsafe request (POST/PUT/PATCH/DELETE) the submitted token must equal the one unsealed from the cookie. Reach for it on cookie-session apps that render forms — it's the standard defense when an attacker's page can make the browser send your cookies. Built on `@usetoki/toki-cookie`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-csrf`,
      },
    },
    { kind: "heading", id: "quick-start", text: "Quick start" },
    {
      kind: "paragraph",
      text: "Register `csrf(app, ...)` once. It adds the `req.csrfToken()` helper and a `preHandler` hook that verifies every unsafe request. Hand the token to the page; the browser sends it back as a form field or a header.",
    },
    {
      kind: "code",
      snippet: {
        filename: "csrf.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { csrf } from "@usetoki/toki-csrf";

const app = createApp();
csrf(app, { secret: process.env.CSRF_SECRET! }); // secret >= 16 bytes

// hand the token to the page (hidden field, or a <meta> for fetch)
app.get("/form", (req) => \`<input name="_csrf" value="\${req.csrfToken()}">\`);

// unsafe methods are verified automatically
app.post("/transfer", () => "done");`,
      },
    },
    {
      kind: "paragraph",
      text: "On verification the submitted token is read from the `x-csrf-token` header, then `csrf-token`, then a `_csrf` form field. The HMAC signature stops an attacker forging the cookie; a missing or mismatched token is rejected with `403`.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Calling `req.csrfToken()` twice in one request returns the same token instead of minting a fresh one — two forms on a page won't clobber each other's cookie.",
    },
    { kind: "heading", id: "spa", text: "SPA / fetch clients" },
    {
      kind: "paragraph",
      text: "A single-page app reads the token from a `<meta>` tag (or a non-`HttpOnly` mirror cookie you set yourself) and sends it on each mutating call as the `x-csrf-token` header.",
    },
    {
      kind: "code",
      snippet: {
        filename: "meta.ts",
        language: "ts",
        code: `app.get("/", (req) => \`
  <!doctype html>
  <meta name="csrf-token" content="\${req.csrfToken()}">
\`);`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "client.ts",
        language: "ts",
        code: `const token = document
  .querySelector('meta[name="csrf-token"]')!
  .getAttribute("content")!;

await fetch("/transfer", {
  method: "POST",
  headers: { "x-csrf-token": token, "content-type": "application/json" },
  body: JSON.stringify({ amount: 100 }),
});`,
      },
    },
    { kind: "heading", id: "origin", text: "Origin checks" },
    {
      kind: "paragraph",
      text: "Layer on a defense-in-depth check that the request actually came from your own site. With `checkOrigin`, the `Origin` (falling back to `Referer`) host must match — and a request carrying neither header is rejected, which is the safe default for a state-changing call.",
    },
    {
      kind: "code",
      snippet: {
        filename: "origin.ts",
        language: "ts",
        code: `// Origin/Referer host must equal the request Host
csrf(app, { secret, checkOrigin: true });

// …or be in this allow-list (e.g. a separate front-end host)
csrf(app, { secret, checkOrigin: ["app.example.com"] });`,
      },
    },
    { kind: "heading", id: "rotation", text: "Cookie attributes & secret rotation" },
    {
      kind: "paragraph",
      text: "The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/` by default. Tune any attribute through `cookie`, and rotate secrets by passing an array — the newest signs, all of them verify, so tokens issued under an old secret keep working until they cycle out.",
    },
    {
      kind: "code",
      snippet: {
        filename: "config.ts",
        language: "ts",
        code: `csrf(app, {
  secret: [process.env.CSRF_SECRET_NEW!, process.env.CSRF_SECRET_OLD!], // newest first
  cookie: { name: "_csrf", sameSite: "Strict", secure: true },
  // read the token from a custom place
  getToken: (req) => req.headers.get("x-xsrf-token") ?? req.form?.fields["_csrf"],
});`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Notes"],
      rows: [
        [
          "`secret`",
          "`string \\| Buffer \\| (…)[]`",
          "— (required)",
          "Signs the token cookie, each ≥ 16 bytes. Array = rotation, newest first.",
        ],
        [
          "`cookie`",
          "`CsrfCookieOptions`",
          "`HttpOnly`, `Lax`, `/`",
          "`name` (default `_csrf`) plus any cookie attribute (`sameSite`, `secure`, `domain`, …).",
        ],
        [
          "`getToken`",
          "`(req) => string \\| undefined`",
          "header then `_csrf` field",
          "Custom extractor for the submitted token.",
        ],
        [
          "`ignoreMethods`",
          "`string[]`",
          "`[\"GET\",\"HEAD\",\"OPTIONS\"]`",
          "Methods that skip the check.",
        ],
        [
          "`checkOrigin`",
          "`boolean \\| string[]`",
          "off",
          "`true` = same host; array = host allow-list.",
        ],
        ["`statusCode`", "`number`", "`403`", "Status for a rejected request."],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The token cookie is signed but not secret-bearing on its own — protection comes from the attacker not being able to read your cookie *and* set the matching header/field. Keep the cookie `HttpOnly`, serve over HTTPS with `secure: true` in production, and don't echo the raw token into a place a cross-site script could read.",
    },
  ],
};
