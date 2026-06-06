import type { DocPage } from "../../types";

export const cachePluginPage: DocPage = {
  slug: "plugin-cache",
  title: "Cache",
  description: "Route response caching with TTL + Vary over an in-memory or Redis store.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-cache` caches whole responses per route. A cache hit replays the stored response from a `preHandler` and skips the handler entirely; a miss captures the response in `onSend`. Only `GET`/`HEAD` and `200`s are cached by default, and a client sending `Cache-Control: no-cache`/`no-store` bypasses the cache both ways.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-cache`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "cache.ts",
        language: "ts",
        code: `import { cache } from "@usetoki/toki-cache";

app.register((api) => {
  cache(api, { ttl: 30 }); // seconds
  api.get("/report", () => buildExpensiveReport());
});`,
      },
    },
    {
      kind: "paragraph",
      text: "The first request runs the handler and stores the response (`X-Cache: MISS`); later requests within the TTL get it straight from the store (`X-Cache: HIT`, plus `Age` and `Cache-Control`). The in-process store is bounded and swept; share a cache across instances with the Redis store.",
    },
    {
      kind: "code",
      snippet: {
        filename: "redis.ts",
        language: "ts",
        code: `import { cache, RedisStore } from "@usetoki/toki-cache";

cache(api, { ttl: 60, store: new RedisStore({ client: redis }) });`,
      },
    },
    {
      kind: "list",
      items: [
        "`ttl` — lifetime in seconds. `store` — a `CacheStore`; default `MemoryStore({ max: 1000 })`.",
        '`methods` / `statuses` — what\'s cacheable. Default `["GET", "HEAD"]` / `[200]`.',
        '`vary` — request headers that partition the cache (echoed as `Vary`), e.g. `["accept-language"]`.',
        "`key` — a custom key builder; `cacheControl` — emit a `Cache-Control` header (default `true`).",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Only status, content type, and body are stored — never `Set-Cookie` or other per-request headers — so a shared cached response can't leak one user's data to another.",
    },
  ],
};
