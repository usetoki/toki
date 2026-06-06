import type { DocPage } from "../../types";

export const cachePluginPage: DocPage = {
  slug: "plugin-cache",
  title: "Cache",
  description: "Whole-response caching with TTL and Vary over a memory, Redis, or memcached store.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-cache` caches whole responses per route. Reach for it when a handler is expensive (a report, an aggregate query, a third-party fetch) and the result is fine to reuse for a few seconds or minutes. On a hit the stored response replays from a `preHandler` and the handler never runs; on a miss the response is captured in `onSend`. Only `GET`/`HEAD` and `200`s are cached by default, and a client sending `Cache-Control: no-cache`/`no-store` bypasses the cache both ways.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-cache`,
      },
    },
    { kind: "heading", id: "quick-start", text: "Quick start" },
    {
      kind: "code",
      snippet: {
        filename: "cache.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { cache } from "@usetoki/toki-cache";

const app = createApp();

app.register((api) => {
  cache(api, { ttl: 30 }); // seconds
  api.get("/report", () => buildExpensiveReport());
});`,
      },
    },
    {
      kind: "paragraph",
      text: "The first request runs the handler and stores the response (`X-Cache: MISS`); later requests within the TTL get it straight from the store (`X-Cache: HIT`, plus `Age` and `Cache-Control`). `cache()` attaches its hooks to the scope you pass, so a `register` block scopes the cache to those routes — call it once per scope.",
    },
    { kind: "heading", id: "vary", text: "Vary on a header" },
    {
      kind: "paragraph",
      text: "When a response depends on a request header — say a localized page — list that header in `vary`. The header value becomes part of the cache key, and it's echoed back as `Vary` so shared proxies do the right thing.",
    },
    {
      kind: "code",
      snippet: {
        filename: "vary.ts",
        language: "ts",
        code: `cache(api, { ttl: 60, vary: ["accept-language"] });

// "en" and "fr" now get separate cache entries:
api.get("/welcome", (req) => renderWelcome(req.headers.get("accept-language")));`,
      },
    },
    { kind: "heading", id: "stores", text: "Stores" },
    {
      kind: "paragraph",
      text: "In-process by default — bounded and swept, so memory tracks live entries instead of growing forever. To share a cache across instances (or survive a restart), pass a `RedisStore` or `MemcachedStore`. Both take any client matching a small interface; the real ioredis and memjs clients fit.",
    },
    {
      kind: "code",
      snippet: {
        filename: "memory.ts",
        language: "ts",
        code: `import { cache, MemoryStore } from "@usetoki/toki-cache";

// default is new MemoryStore({ max: 1000 }); pass your own to tune the cap.
cache(api, { ttl: 30, store: new MemoryStore({ max: 5000 }) });`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "redis.ts",
        language: "ts",
        code: `import Redis from "ioredis";
import { cache, RedisStore } from "@usetoki/toki-cache";

const redis = new Redis(process.env.REDIS_URL);
cache(api, { ttl: 60, store: new RedisStore({ client: redis }) });`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "memcached.ts",
        language: "ts",
        code: `import memjs from "memjs";
import { cache, MemcachedStore } from "@usetoki/toki-cache";

const mc = memjs.Client.create(process.env.MEMCACHED_SERVERS);

// thin wrapper to match the MemcachedClient surface
const client = {
  async get(key: string) {
    const { value } = await mc.get(key);
    return value ? value.toString() : null;
  },
  async set(key: string, value: string, ttlSeconds: number) {
    await mc.set(key, value, { expires: ttlSeconds });
  },
  async delete(key: string) {
    await mc.delete(key);
  },
};

cache(api, { ttl: 120, store: new MemcachedStore({ client }) });`,
      },
    },
    {
      kind: "paragraph",
      text: "Need another backend? Implement `CacheStore` — `get(key)`, `set(key, entry, ttlMs)`, and an optional `delete(key)`. Bodies are stored as bytes, so binary responses survive the round trip.",
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "What it does"],
      rows: [
        ["`ttl`", "`number`", "—", "Lifetime in seconds. Required."],
        ["`store`", "`CacheStore`", "`MemoryStore({ max: 1000 })`", "Where entries live."],
        ["`methods`", "`string[]`", '`["GET", "HEAD"]`', "Methods worth caching."],
        ["`statuses`", "`number[]`", "`[200]`", "Statuses worth caching."],
        [
          "`vary`",
          "`string[]`",
          "`[]`",
          "Request headers that partition the cache, echoed as `Vary`.",
        ],
        [
          "`key`",
          "`(req) => string`",
          "method + path + query (+ vary)",
          "Custom cache-key builder.",
        ],
        ["`cacheControl`", "`boolean`", "`true`", "Emit a `Cache-Control: public, max-age=…`."],
      ],
    },
    {
      kind: "table",
      headers: ["MemoryStore option", "Default", "What it does"],
      rows: [
        ["`max`", "`1000`", "Hard cap on entries; the least-recently-used is evicted past it."],
        ["`sweepMs`", "`60000`", "How often expired entries are swept, in ms."],
      ],
    },
    { kind: "heading", id: "notes", text: "Notes" },
    {
      kind: "callout",
      tone: "warning",
      text: "A handler that stages `Cache-Control: private` / `no-store` / `no-cache` (via `req.setResponseHeader`) is never cached — mark per-user responses that way so they can't land in a shared cache.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Only status, content type, body, and safe headers (e.g. `ETag`, `Location`) are stored — never `Set-Cookie`. A shared cached response can't leak one user's cookie to another.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "Caching is best-effort: if the store write fails the original response still goes out (the error is logged via `req.log`), it just isn't cached.",
    },
  ],
};
