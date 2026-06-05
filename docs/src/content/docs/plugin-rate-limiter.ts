import type { DocPage } from "../../types";

export const rateLimiterPluginPage: DocPage = {
  slug: "plugin-rate-limiter",
  title: "Rate limiter",
  description: "Per-route, per-key rate limiting with memory, Redis, KeyDB, and memcached stores.",
  blocks: [
    {
      kind: "callout",
      tone: "note",
      text: "Not the same as toki's built-in [Rate limiting](/docs/rate-limiting). That one is a global per-IP guard in the Zig engine that drops requests before they reach JS. This plugin runs in JS for per-route and per-key control — different routes, different budgets; key by user, API key, or IP + path.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-ratelimiter`,
      },
    },
    { kind: "heading", id: "per-route", text: "Per route, per IP" },
    {
      kind: "paragraph",
      text: "Attach a limiter to one route's `preHandler`. It keys on the client IP by default and owns its own counter, so this route's budget is independent of every other.",
    },
    {
      kind: "code",
      snippet: {
        filename: "login.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { rateLimit } from "@usetoki/toki-ratelimiter";

const app = createApp();

app.get(
  "/login",
  { preHandler: rateLimit({ max: 5, windowMs: 60_000 }) }, // 5/min per IP, this route only
  () => reply.text("ok"),
);

app.listen(3000);`,
      },
    },
    { kind: "heading", id: "custom-keys", text: "Custom keys" },
    {
      kind: "code",
      snippet: {
        filename: "keys.ts",
        language: "ts",
        code: `// per API key instead of per IP
rateLimit({ max: 100, windowMs: 60_000, keyGenerator: (req) => req.headers.get("x-api-key") ?? req.ip });

// one app-wide limiter, keyed per IP *and* path
app.use(rateLimit({ max: 600, windowMs: 60_000, keyGenerator: (req) => \`\${req.ip}:\${req.path}\` }));`,
      },
    },
    { kind: "heading", id: "block", text: "Block response" },
    {
      kind: "paragraph",
      text: "A blocked request gets `429` (override with `statusCode`), a `Retry-After` header, and a JSON body. Replace the body with `message` — a string, or a builder from the limit info.",
    },
    {
      kind: "code",
      snippet: {
        filename: "message.ts",
        language: "ts",
        code: `rateLimit({
  max: 10,
  windowMs: 1_000,
  message: (req, info) => reply.json({ error: "slow down", retryAfter: info.retryAfter }, 429),
});`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Notes"],
      rows: [
        ["`max`", "—", "requests allowed per window, per key"],
        ["`windowMs`", "—", "window length in ms"],
        ["`keyGenerator`", "`req => req.ip`", "bucket key for a request"],
        ["`skip`", "—", "return `true` to bypass limiting"],
        ["`statusCode`", "`429`", "status for a blocked request"],
        ["`message`", "JSON `Too Many Requests`", "string, or a builder from the limit info"],
        ["`standardHeaders`", "`true`", "emit draft `RateLimit-*` headers"],
        ["`legacyHeaders`", "`false`", "emit legacy `X-RateLimit-*` headers"],
        ["`store`", "a fresh `MemoryStore`", "swap for a shared or Redis-backed store"],
      ],
    },
    { kind: "heading", id: "stores", text: "Stores" },
    {
      kind: "paragraph",
      text: "A store is where the counters live. The default `MemoryStore` is per-process; use a shared store to limit across many instances behind a load balancer. The clients are not dependencies — bring your own and pass it in.",
    },
    {
      kind: "table",
      headers: ["Store", "Backend", "Notes"],
      rows: [
        ["`MemoryStore`", "in-process", "default; fixed window, sweeps expired keys"],
        [
          "`RedisStore`",
          "Redis · KeyDB · Valkey · Dragonfly · Upstash",
          "atomic Lua, one round trip, shared counters",
        ],
        ["`MemcachedStore`", "memcached", "`add`+`incr` window; `Retry-After` is approximate"],
      ],
    },
    { kind: "heading", id: "redis", text: "Redis / KeyDB / Valkey" },
    {
      kind: "paragraph",
      text: "All speak the Redis protocol, so one store covers them. `RedisStore` runs an atomic Lua script (`INCR` + `PEXPIRE` + `PTTL`) — one race-free round trip. `ioredis` matches the expected client shape directly.",
    },
    {
      kind: "code",
      snippet: {
        filename: "redis.ts",
        language: "ts",
        code: `import Redis from "ioredis";
import { rateLimit, RedisStore } from "@usetoki/toki-ratelimiter";

const client = new Redis(process.env.REDIS_URL); // or new Redis({ host: "keydb", port: 6379 })
const store = new RedisStore({ client, prefix: "rl:" });

app.get("/api", { preHandler: rateLimit({ max: 100, windowMs: 60_000, store }) }, handler);`,
      },
    },
    {
      kind: "paragraph",
      text: "`node-redis` (v4) has a different `eval` signature, so wrap it:",
    },
    {
      kind: "code",
      snippet: {
        filename: "node-redis.ts",
        language: "ts",
        code: `import { createClient } from "redis";
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = new RedisStore({
  client: {
    eval: (script, numKeys, ...args) =>
      redis.eval(script, { keys: args.slice(0, numKeys), arguments: args.slice(numKeys).map(String) }),
  },
});`,
      },
    },
    { kind: "heading", id: "memcached", text: "Memcached" },
    {
      kind: "callout",
      tone: "warning",
      text: "memcached can't report a key's remaining TTL, so `Retry-After` is the full window length — an upper bound, not the exact time left. The counter still expires server-side at the real TTL.",
    },
    {
      kind: "code",
      snippet: {
        filename: "memcached.ts",
        language: "ts",
        code: `import { Client } from "memjs";
import { MemcachedStore } from "@usetoki/toki-ratelimiter";

const mc = Client.create(process.env.MEMCACHED_SERVERS);
const store = new MemcachedStore({
  client: {
    add: (key, value, ttl) => mc.add(key, value, { expires: ttl }),
    incr: async (key, amount) => (await mc.increment(key, amount)).value ?? null,
  },
});`,
      },
    },
    { kind: "heading", id: "custom-store", text: "Custom store" },
    {
      kind: "paragraph",
      text: "Implement the `Store` interface — a single `hit(key, windowMs)` returning `{ count, resetAt }` (sync or async) — to back the limiter with anything: SQL, DynamoDB, a sliding-window log.",
    },
    {
      kind: "code",
      snippet: {
        filename: "custom-store.ts",
        language: "ts",
        code: `import type { Store, StoreHit } from "@usetoki/toki-ratelimiter";

class MyStore implements Store {
  async hit(key: string, windowMs: number): Promise<StoreHit> {
    // count this hit, return the running total + window reset (epoch ms)
    return { count, resetAt };
  }
}`,
      },
    },
  ],
};
