# @usetoki/toki-cookie

Signed and encrypted cookies for [toki](https://usetoki.github.io/toki/): HMAC + AES-256-GCM
with key rotation. The crypto base used by the session plugins, and handy on its own.

```bash
npm install @usetoki/toki-cookie
```

## Usage

```ts
import { createApp } from "@usetoki/toki";
import { createCookies } from "@usetoki/toki-cookie";

const cookies = createCookies({ secret: process.env.COOKIE_SECRET! }); // >= 16 bytes

const app = createApp();

app.get("/login", (req) => {
  req.setCookie("uid", cookies.sign("user-42"), { httpOnly: true, sameSite: "Lax" });
  return "ok";
});

app.get("/me", (req) => {
  const uid = cookies.unsign(req.cookies.uid ?? ""); // string, or null if missing/tampered
  return { uid };
});
```

- `sign` / `unsign` — HMAC; the value stays readable, the tag proves integrity.
- `seal` / `unseal` — AES-256-GCM; the cookie is opaque. `unseal` returns `null` on tamper.

## Key rotation

Pass an array. The first secret signs/encrypts new cookies, the rest are still accepted,
so you can roll a secret out without invalidating live cookies:

```ts
createCookies({ secret: [newSecret, oldSecret] });
```

`unsign` / `unseal` return `null` for a missing, tampered, or unknown-key cookie — they never throw.
