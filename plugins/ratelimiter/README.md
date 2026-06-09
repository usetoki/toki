# @usetoki/toki-ratelimiter

Flexible rate limiting for [toki](https://usetoki.github.io/toki/) — per route, per
key, in plain JavaScript. HTTP requests (`rateLimit`), raw TCP connections
(`tcpRateLimit`), and UDP datagrams (`udpRateLimit`), all over the same pluggable
stores — so one Redis counter can budget a client across every transport.

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

## Raw TCP

`tcpRateLimit(options, handler)` wraps a `createTcpServer` connection handler and
counts accepted connections per key (the peer IP by default). Over the limit the
connection is destroyed — or hand it `onLimit` to say goodbye on the wire instead.

```ts
import { createTcpServer } from "@usetoki/toki";
import { tcpRateLimit } from "@usetoki/toki-ratelimiter";

const server = createTcpServer(
  tcpRateLimit(
    { max: 20, windowMs: 60_000, onLimit: (socket) => socket.end("BUSY\r\n") },
    (socket) => socket.on("data", (chunk) => socket.write(chunk)),
  ),
);
server.listen(9000);
```

With the default `MemoryStore` the verdict is synchronous and an admitted connection
reaches the handler as the bare socket — zero added cost. With an async store (Redis),
bytes arriving while the verdict is in flight are buffered and replayed in order.

> `createTcpServer` also takes a native `rateLimit` listen option — a per-IP accept
> guard inside the Zig engine that resets floods **before the TLS handshake**. They
> compose: the native guard absorbs volume, this one enforces policy.

## UDP

`udpRateLimit(options, onMessage)` wraps a `createUdpServer` message handler and
counts datagrams per key (the sender IP by default). Over-limit datagrams are dropped
silently — replying to one would hand a spoofing attacker an amplifier. `onLimit`
lets you observe the drops.

```ts
import { createUdpServer } from "@usetoki/toki";
import { udpRateLimit } from "@usetoki/toki-ratelimiter";

const server = createUdpServer(
  udpRateLimit({ max: 50, windowMs: 1_000 }, (msg, rinfo, socket) => {
    socket.send(msg, rinfo.port, rinfo.address); // echo
  }),
);
server.bind(9001);
```

> The engine-side twin is `createUdpServer`'s native `rateLimit` bind option, which
> drops over-limit packets before they ever cross into JS.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `max` | — | hits allowed per window, per key |
| `windowMs` | — | window length in ms |
| `keyGenerator` | `req => req.ip` | bucket key (`socket` for TCP, `rinfo` for UDP) |
| `skip` | — | return `true` to bypass limiting |
| `statusCode` | `429` | HTTP only: status for a blocked request |
| `message` | JSON `Too Many Requests` | HTTP only: string, or a builder from the limit info |
| `standardHeaders` | `true` | HTTP only: emit draft `RateLimit-*` headers |
| `legacyHeaders` | `false` | HTTP only: emit legacy `X-RateLimit-*` headers |
| `onLimit` | destroy / drop | TCP & UDP only: hook replacing the default over-limit action |
| `store` | a fresh `MemoryStore` | swap for a shared/Redis-backed `Store` |
| `onStoreError` | `"open"` | `"open"` admits when the store throws; `"closed"` rejects |

## Stores

A store is where the counters live. The default `MemoryStore` is per-process; use a
shared store to limit across many instances behind a load balancer. Built in:

| Store | Backend | Notes |
| --- | --- | --- |
| `MemoryStore` | in-process | default; fixed window, sweeps expired keys |
| `RedisStore` | Redis · KeyDB · Valkey · Dragonfly · Upstash | atomic Lua, one round trip, shared counters |
| `MemcachedStore` | memcached | `add`+`incr` window; `Retry-After` is approximate (no TTL read) |

Share one store across limiters for a common pool:

```ts
import { MemoryStore } from "@usetoki/toki-ratelimiter";

const store = new MemoryStore();
app.get("/a", { preHandler: rateLimit({ max: 10, windowMs: 1000, store }) }, handlerA);
app.get("/b", { preHandler: rateLimit({ max: 10, windowMs: 1000, store }) }, handlerB); // shared pool
```

The clients are **not** dependencies — bring your own and pass it in.

### Redis / KeyDB / Valkey

All speak the Redis protocol, so the same store covers them. `RedisStore` runs an
atomic Lua script (`INCR` + `PEXPIRE` + `PTTL`) — one race-free round trip.

```ts
import Redis from "ioredis";
import { RedisStore } from "@usetoki/toki-ratelimiter";

const client = new Redis(process.env.REDIS_URL); // or new Redis({ host: "keydb", port: 6379 })
const store = new RedisStore({ client, prefix: "rl:" });

app.get("/api", { preHandler: rateLimit({ max: 100, windowMs: 60_000, store }) }, handler);
```

ioredis matches the expected client shape directly. **node-redis (v4)** has a different
`eval` signature, so wrap it:

```ts
import { createClient } from "redis";
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = new RedisStore({
  client: {
    eval: (script, numKeys, ...args) =>
      redis.eval(script, { keys: args.slice(0, numKeys), arguments: args.slice(numKeys).map(String) }),
  },
});
```

### Memcached

memcached can't report a key's remaining TTL, so `Retry-After` is the full window
length (an upper bound). Modern **memjs** (promise-based) wraps cleanly:

```ts
import { Client } from "memjs";
import { MemcachedStore } from "@usetoki/toki-ratelimiter";

const mc = Client.create(process.env.MEMCACHED_SERVERS);
const store = new MemcachedStore({
  client: {
    add: (key, value, ttl) => mc.add(key, value, { expires: ttl }),
    incr: async (key, amount) => (await mc.increment(key, amount)).value ?? null,
  },
});
```

### Custom store

Implement `Store` — a single `hit(key, windowMs)` returning `{ count, resetAt }` (sync
or async) — to back the limiter with anything (SQL, DynamoDB, a sliding-window log).

```ts
import type { Store, StoreHit } from "@usetoki/toki-ratelimiter";

class MyStore implements Store {
  async hit(key: string, windowMs: number): Promise<StoreHit> {
    // ... count this hit, return the running total + window reset (epoch ms)
  }
}
```
