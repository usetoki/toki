# @usetoki/toki-csrf

CSRF protection for [toki](https://usetoki.github.io/toki/): signed double-submit tokens
with optional origin checks. Built on `@usetoki/toki-cookie`.

```bash
npm install @usetoki/toki-csrf
```

## Usage

```ts
import { createApp } from "@usetoki/toki";
import { csrf } from "@usetoki/toki-csrf";

const app = createApp();
csrf(app, { secret: process.env.CSRF_SECRET! }); // >= 16 bytes

// hand the token to the page (hidden field, or a <meta> for fetch)
app.get("/form", (req) => `<input name="_csrf" value="${req.csrfToken()}">`);

// unsafe methods are verified automatically
app.post("/transfer", () => "done");
```

`req.csrfToken()` mints a random token, signs it into a cookie, and returns the raw value
for the page to send back. On every unsafe request (`POST`/`PUT`/`PATCH`/`DELETE`) the
submitted token must equal the one unsealed from the cookie, or the request is rejected
with `403`. The HMAC signature stops an attacker forging the cookie; it's `HttpOnly` by
default.

The token is read from the `x-csrf-token` (or `csrf-token`) header, then a `_csrf` form
field. Override with `getToken`.

## Origin checks

Add a defense-in-depth check that the request came from your own site:

```ts
csrf(app, { secret, checkOrigin: true });            // Origin/Referer host must equal the request Host
csrf(app, { secret, checkOrigin: ["app.example.com"] }); // …or be in this allow-list
```

## Options

- **`secret`** — string/Buffer or an array for rotation (newest first).
- **`cookie`** — `name` (default `_csrf`) plus any cookie attribute (`sameSite`, `secure`, …).
- **`getToken`** — custom extractor `(req) => string | undefined`.
- **`ignoreMethods`** — default `["GET", "HEAD", "OPTIONS"]`.
- **`checkOrigin`** — `true` for same-host, or an array of allowed hosts.
- **`statusCode`** — rejection status, default `403`.
