# @usetoki/toki-session

Stateful sessions for [toki](https://usetoki.github.io/toki/) — a signed session id in a
cookie, the data in a pluggable store (in-memory, Redis/KeyDB, or memcached). For larger
sessions or anything you need to revoke server-side.

```bash
npm install @usetoki/toki-session
```

## Usage

```ts
import { createApp, reply } from "@usetoki/toki";
import { session } from "@usetoki/toki-session";

const app = createApp();
session(app, { secret: process.env.SESSION_SECRET! }); // in-memory store by default

app.post("/login", (req) => {
  req.session.regenerate(); // new id on privilege change — stops session fixation
  req.session.set("userId", 42);
  return reply.text("ok");
});

app.get("/me", (req) => reply.json({ userId: req.session.get("userId") ?? null }));
app.post("/logout", (req) => {
  req.session.destroy();
  return reply.text("bye");
});
```

`req.session`: `id` · `get` · `set` · `delete` · `has` · `regenerate` · `destroy` · `data`. The cookie is
only written for a new or regenerated session; data writes hit the store.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `secret` | — | secret(s) signing the id cookie (each >= 16 bytes), newest first |
| `store` | `MemoryStore` | where data lives |
| `maxAge` | `86400` | lifetime in seconds |
| `rolling` | `false` | re-issue + touch on every response to slide the expiry |
| `cookie` | `{ name: "sid", httpOnly, sameSite: "Lax", path: "/" }` | cookie name + attributes |

## Stores

The clients are not dependencies — bring your own.

```ts
import Redis from "ioredis";
import { RedisStore } from "@usetoki/toki-session";

session(app, { secret, store: new RedisStore({ client: new Redis(process.env.REDIS_URL) }) });
```

`MemoryStore` (default, single process), `RedisStore` (Redis · KeyDB · Valkey · Upstash; node-redis
v4 needs a thin wrapper), and `MemcachedStore` are built in. Implement the `SessionStore` interface
(`get` / `set` / `destroy` / optional `touch`) to back it with anything else.
