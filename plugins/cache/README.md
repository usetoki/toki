# @usetoki/toki-cache

Route response caching for [toki](https://usetoki.github.io/toki/), with TTL and `Vary` over
an in-memory or Redis store. A cache hit replays the stored response and skips the handler
entirely.

```bash
npm install @usetoki/toki-cache
```

## Usage

```ts
import { createApp } from "@usetoki/toki";
import { cache } from "@usetoki/toki-cache";

const app = createApp();

app.register((api) => {
  cache(api, { ttl: 30 }); // seconds
  api.get("/report", () => buildExpensiveReport());
});
```

The first request runs the handler and stores the response (`X-Cache: MISS`); subsequent
requests within the TTL get it straight from the store (`X-Cache: HIT`, plus `Age` and
`Cache-Control`). Only `GET`/`HEAD` and `200`s are cached by default, and a client sending
`Cache-Control: no-cache`/`no-store` bypasses the cache both ways.

## Stores

In-process by default (bounded, with a periodic sweep). To share a cache across instances,
use the Redis store with any ioredis-style client:

```ts
import { cache, RedisStore } from "@usetoki/toki-cache";

cache(api, { ttl: 60, store: new RedisStore({ client: redis }) });
```

## Options

- **`ttl`** — lifetime in seconds.
- **`store`** — a `CacheStore`; default is an in-process `MemoryStore({ max: 1000 })`.
- **`methods`** / **`statuses`** — what's cacheable. Default `["GET", "HEAD"]` / `[200]`.
- **`vary`** — request headers that partition the cache (and are echoed as `Vary`),
  e.g. `["accept-language"]`.
- **`key`** — a custom key builder `(req) => string`.
- **`cacheControl`** — emit a `Cache-Control` header. Default `true`.

Responses are keyed by method + path + query (plus any `vary` values). Set-Cookie and
other per-request headers are **not** stored — only status, content type, and body — so a
shared response never leaks one user's cookie to another.
