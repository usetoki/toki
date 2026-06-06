import type { DocPage } from "../../types";

export const csrfPluginPage: DocPage = {
  slug: "plugin-csrf",
  title: "CSRF",
  description: "CSRF protection — signed double-submit tokens with optional origin checks.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-csrf` protects state-changing requests with a signed double-submit token. `req.csrfToken()` mints a random token, signs it into an `HttpOnly` cookie, and returns the raw value for the page to send back. On every unsafe request the submitted token must equal the one unsealed from the cookie. Built on `@usetoki/toki-cookie`.",
    },
    {
      kind: "code",
      snippet: { filename: "install.sh", language: "bash", code: `npm install @usetoki/toki-csrf` },
    },
    {
      kind: "code",
      snippet: {
        filename: "csrf.ts",
        language: "ts",
        code: `import { csrf } from "@usetoki/toki-csrf";

const app = createApp();
csrf(app, { secret: process.env.CSRF_SECRET! }); // >= 16 bytes

// hand the token to the page (hidden field, or a <meta> for fetch)
app.get("/form", (req) => \`<input name="_csrf" value="\${req.csrfToken()}">\`);

// unsafe methods (POST/PUT/PATCH/DELETE) are verified automatically
app.post("/transfer", () => "done");`,
      },
    },
    {
      kind: "paragraph",
      text: "The submitted token is read from the `x-csrf-token` (or `csrf-token`) header, then a `_csrf` form field. The HMAC signature stops an attacker forging the cookie; a missing or mismatched token is rejected with `403`.",
    },
    { kind: "heading", id: "origin", text: "Origin checks" },
    {
      kind: "paragraph",
      text: "Add a defense-in-depth check that the request came from your own site:",
    },
    {
      kind: "code",
      snippet: {
        filename: "origin.ts",
        language: "ts",
        code: `csrf(app, { secret, checkOrigin: true });                 // Origin/Referer host must equal the request Host
csrf(app, { secret, checkOrigin: ["app.example.com"] }); // …or be in this allow-list`,
      },
    },
    {
      kind: "list",
      items: [
        "`secret` — string/Buffer, or an array for rotation (newest first).",
        "`cookie` — `name` (default `_csrf`) plus any cookie attribute (`sameSite`, `secure`, …).",
        "`getToken` — custom extractor `(req) => string | undefined`.",
        '`ignoreMethods` — default `["GET", "HEAD", "OPTIONS"]`; `statusCode` — default `403`.',
      ],
    },
  ],
};
