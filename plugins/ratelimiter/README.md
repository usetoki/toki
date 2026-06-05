# @usetoki/toki-ratelimiter

Flexible rate limiting for [toki](https://usetoki.github.io/toki/) — per route, per
key, in plain JavaScript. A middleware you can attach exactly where you want, with a
custom key function and a pluggable store.

```bash
npm install @usetoki/toki-ratelimiter
```

> Not the same as toki's built-in native limiter. `listen({ rateLimit })` is a global
> per-IP guard in the Zig engine that drops over-limit requests before they reach JS.
> This plugin runs in JS for **per-route** and **per-key** control (different routes,
> different budgets; key by user, API key, IP + path, …).

## Per-route, per-IP

Attach a limiter to a single route's `preHandler`. It keys on the client IP by
default, and owns its own counter — so this route's budget is independent of others.

```ts
import { createApp, reply } from "@usetoki/toki";
import { rateLimit } from "@usetoki/toki-ratelimiter";

const app = createApp();

app.get(
  "/login",
  { preHandler: rateLimit({ max: 5, windowMs: 60_000 }) }, // 5/min per IP, this route only
  () => reply.text("ok"),
);

app.listen(3000);
```

## Custom keys

```ts
// per API key instead of per IP
rateLimit({ max: 100, windowMs: 60_000, keyGenerator: (req) => req.headers.get("x-api-key") ?? req.ip });

// per IP *and* path, as one app-wide limiter
app.use(rateLimit({ max: 600, windowMs: 60_000, keyGenerator: (req) => `${req.ip}:${req.path}` }));
```

## Response on block

A blocked request gets `429` (override with `statusCode`), a `Retry-After` header, and
a JSON body. Customize the body with `message`:

```ts
rateLimit({
  max: 10,
  windowMs: 1_000,
  message: (req, info) => reply.json({ error: "slow down", retryAfter: info.retryAfter }, 429),
});
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `max` | — | requests allowed per window, per key |
| `windowMs` | — | window length in ms |
| `keyGenerator` | `req => req.ip` | bucket key for a request |
| `skip` | — | return `true` to bypass limiting |
| `statusCode` | `429` | status for a blocked request |
| `message` | JSON `Too Many Requests` | string, or a builder from the limit info |
| `standardHeaders` | `true` | emit draft `RateLimit-*` headers |
| `legacyHeaders` | `false` | emit legacy `X-RateLimit-*` headers |
| `store` | a fresh `MemoryStore` | swap for a shared/Redis-backed `Store` |

## Stores

The default `MemoryStore` is an in-process fixed window that evicts expired keys on a
periodic sweep. Share one store across limiters for a common pool, or implement the
`Store` interface (`hit(key, windowMs)`) against Redis to limit across instances.

```ts
import { MemoryStore } from "@usetoki/toki-ratelimiter";

const store = new MemoryStore();
app.get("/a", { preHandler: rateLimit({ max: 10, windowMs: 1000, store }) }, handlerA);
app.get("/b", { preHandler: rateLimit({ max: 10, windowMs: 1000, store }) }, handlerB); // shared pool
```
