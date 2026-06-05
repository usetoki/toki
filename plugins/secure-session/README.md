# @usetoki/toki-secure-session

Stateless sessions for [toki](https://usetoki.github.io/toki/) — the whole session lives in
an encrypted cookie (AES-256-GCM), so there's no server-side store to run. Great for small
sessions and horizontally-scaled apps.

```bash
npm install @usetoki/toki-secure-session
```

## Usage

```ts
import { createApp, reply } from "@usetoki/toki";
import { secureSession } from "@usetoki/toki-secure-session";

const app = createApp();
secureSession(app, { secret: process.env.SESSION_SECRET! }); // gives every route req.session

app.post("/login", (req) => {
  req.session.set("userId", 42);
  return reply.text("ok");
});

app.get("/me", (req) => reply.json({ userId: req.session.get("userId") ?? null }));

app.post("/logout", (req) => {
  req.session.destroy();
  return reply.text("bye");
});
```

`req.session`: `get` · `set` · `delete` · `has` · `regenerate` · `destroy` · `data`. The cookie is
only (re-)issued when the session actually changes.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `secret` | — | one or more secrets (each >= 16 bytes); the first is current, the rest rotate |
| `maxAge` | `86400` | lifetime in seconds; `0` disables expiry |
| `rolling` | `false` | re-issue the cookie each response to slide the expiry |
| `cookie` | `{ name: "session", httpOnly, sameSite: "Lax", path: "/" }` | cookie name + attributes |

A session is capped at the ~4 KB cookie limit — exceed it and `secureSession` throws on save,
pointing you at [`@usetoki/toki-session`](https://www.npmjs.com/package/@usetoki/toki-session)
(server-side store) instead.
