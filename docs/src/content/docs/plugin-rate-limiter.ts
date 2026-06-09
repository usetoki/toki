import type { DocPage } from "../../types";

export const rateLimiterPluginPage: DocPage = {
  slug: "plugin-rate-limiter",
  title: "Rate limiter",
  description:
    "Per-key rate limiting for HTTP routes, raw TCP connections, and UDP datagrams, with memory, Redis, KeyDB, and memcached stores.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-ratelimiter` caps how many hits a key may make per time window — HTTP requests via `rateLimit`, raw TCP connections via [`tcpRateLimit`](#tcp), UDP datagrams via [`udpRateLimit`](#udp). Use it when one route needs a tighter budget than the rest (a login endpoint, a password-reset, an expensive search) or to meter an API per user or per API key rather than per IP. Each limiter owns its own counter, so different routes never share a budget unless you tell them to — and all three limiters speak the same `Store`, so one Redis counter can span every transport.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "This is not toki's built-in [Rate limiting](/docs/rate-limiting). That one is a global per-IP guard in the Zig engine that drops floods before they reach JS. This plugin runs in JS for per-route, per-key control. Run both: the engine for coarse flood protection, this for fine-grained policy.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-ratelimiter`,
      },
    },
    { kind: "heading", id: "quick-start", text: "Quick start" },
    {
      kind: "paragraph",
      text: "Attach a limiter to one route's `preHandler`. It keys on the client IP by default and owns its own counter, so this route's budget is independent of every other route.",
    },
    {
      kind: "code",
      snippet: {
        filename: "login.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { rateLimit } from "@usetoki/toki-ratelimiter";

const app = createApp();

app.post(
  "/login",
  { preHandler: rateLimit({ max: 5, windowMs: 60_000 }) }, // 5/min per IP, this route only
  () => reply.text("ok"),
);

app.listen(3000);`,
      },
    },
    {
      kind: "paragraph",
      text: "Within budget the limiter returns nothing and the request flows through. Over budget it short-circuits with `429`, a `Retry-After` header, and a JSON body. By default it also stages the draft `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers on every response.",
    },
    { kind: "heading", id: "keys", text: "Keying: user, API key, IP + path" },
    {
      kind: "paragraph",
      text: "`keyGenerator` decides which bucket a request counts against. Return a stable string per caller. A common pattern: meter authenticated users by id and fall back to IP for anonymous traffic.",
    },
    {
      kind: "code",
      snippet: {
        filename: "keys.ts",
        language: "ts",
        code: `// per API key, falling back to IP when the header is absent
rateLimit({
  max: 1_000,
  windowMs: 60_000,
  keyGenerator: (req) => req.headers.get("x-api-key") ?? req.ip,
});

// one app-wide limiter, keyed per IP *and* path so each endpoint gets its own budget
app.use(rateLimit({ max: 600, windowMs: 60_000, keyGenerator: (req) => \`\${req.ip}:\${req.path}\` }));`,
      },
    },
    { kind: "heading", id: "skip", text: "Skipping trusted traffic" },
    {
      kind: "paragraph",
      text: "`skip` runs before the counter. Return `true` to wave a request through untouched: health checks, an internal service, an allow-listed key.",
    },
    {
      kind: "code",
      snippet: {
        filename: "skip.ts",
        language: "ts",
        code: `rateLimit({
  max: 100,
  windowMs: 60_000,
  skip: (req) => req.headers.get("x-internal-token") === process.env.INTERNAL_TOKEN,
});`,
      },
    },
    { kind: "heading", id: "block", text: "Custom block response" },
    {
      kind: "paragraph",
      text: "A blocked request gets `statusCode` (default `429`), a `Retry-After` header, and a JSON body. Replace the body with `message` — a fixed string, or a builder that reads the live limit info. If your builder returns `null`/`undefined`, the default body is used.",
    },
    {
      kind: "code",
      snippet: {
        filename: "message.ts",
        language: "ts",
        code: `rateLimit({
  max: 10,
  windowMs: 1_000,
  message: (req, info) =>
    reply.json({ error: "slow down", retryAfter: info.retryAfter, resetAt: info.resetAt }, 429),
});`,
      },
    },
    { kind: "heading", id: "tcp", text: "Raw TCP connections" },
    {
      kind: "paragraph",
      text: "`tcpRateLimit(options, handler)` wraps a `createTcpServer` connection handler and counts accepted connections per key — the peer IP by default. An over-limit connection is destroyed; give it `onLimit` to say goodbye on the wire, log, or escalate instead.",
    },
    {
      kind: "code",
      snippet: {
        filename: "tcp.ts",
        language: "ts",
        code: `import { createTcpServer } from "@usetoki/toki";
import { tcpRateLimit } from "@usetoki/toki-ratelimiter";

const server = createTcpServer(
  tcpRateLimit(
    {
      max: 20,
      windowMs: 60_000,
      onLimit: (socket) => socket.end("BUSY\\r\\n"), // default: socket.destroy()
    },
    (socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
    },
  ),
);
server.listen(9000);`,
      },
    },
    {
      kind: "paragraph",
      text: "With the default `MemoryStore` the verdict is synchronous and an admitted connection reaches your handler as the bare socket — zero added cost. With an async store (Redis), bytes that arrive while the verdict is in flight are buffered and replayed in order once the connection is admitted, so a fast client loses nothing.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "`createTcpServer` also takes a native `rateLimit` listen option — a per-IP accept guard inside the engine that resets floods *before the TLS handshake*. They compose: the native guard absorbs volume, `tcpRateLimit` enforces policy (custom keys, shared stores, graceful goodbyes). See [TCP → Rate limiting accepts](/docs/tcp#rate-limit).",
    },
    { kind: "heading", id: "udp", text: "UDP datagrams" },
    {
      kind: "paragraph",
      text: "`udpRateLimit(options, onMessage)` wraps a `createUdpServer` message handler and counts datagrams per key — the sender IP by default. An over-limit datagram is dropped silently; `onLimit` lets you observe the drop. Replying to an over-limit datagram is deliberately not the default: a spoofed source would turn your reply into an amplification attack.",
    },
    {
      kind: "code",
      snippet: {
        filename: "udp.ts",
        language: "ts",
        code: `import { createUdpServer } from "@usetoki/toki";
import { udpRateLimit } from "@usetoki/toki-ratelimiter";

const server = createUdpServer(
  udpRateLimit(
    { max: 50, windowMs: 1_000 }, // 50 datagrams per sender per second
    (msg, rinfo, socket) => {
      socket.send(msg, rinfo.port, rinfo.address); // echo
    },
  ),
);
server.bind(9001);`,
      },
    },
    {
      kind: "paragraph",
      text: "Key on more than the address when your protocol carries identity — an app-level sender id, a session token from the payload:",
    },
    {
      kind: "code",
      snippet: {
        filename: "udp-keys.ts",
        language: "ts",
        code: `udpRateLimit(
  { max: 100, windowMs: 60_000, keyGenerator: (rinfo) => \`\${rinfo.address}:\${rinfo.port}\` },
  onMessage,
);`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "The engine-side twin here is `createUdpServer`'s native `rateLimit` bind option, which drops over-limit packets before they cross into JS at all — see [UDP → Rate limiting datagrams](/docs/udp#rate-limit).",
    },
    { kind: "heading", id: "shared-budget", text: "One budget across transports" },
    {
      kind: "paragraph",
      text: "All three limiters take the same `store`. Hand them one instance and a client's HTTP requests, TCP connections, and datagrams all draw down a single budget — per process with a shared `MemoryStore`, fleet-wide with a `RedisStore`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "shared.ts",
        language: "ts",
        code: `import { MemoryStore, rateLimit, tcpRateLimit, udpRateLimit } from "@usetoki/toki-ratelimiter";

const store = new MemoryStore();

app.use(rateLimit({ max: 100, windowMs: 60_000, store }));
const tcpHandler = tcpRateLimit({ max: 100, windowMs: 60_000, store }, handler);
const onMessage = udpRateLimit({ max: 100, windowMs: 60_000, store }, handleDatagram);`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Notes"],
      rows: [
        ["`max`", "—", "requests allowed per window, per key (required)"],
        ["`windowMs`", "—", "window length in ms (required)"],
        ["`keyGenerator`", "`req => req.ip`", "bucket key for a request"],
        ["`skip`", "—", "return `true` to bypass limiting for this request"],
        ["`statusCode`", "`429`", "status for a blocked request"],
        ["`message`", "JSON `Too Many Requests`", "fixed string, or a builder from the limit info"],
        ["`standardHeaders`", "`true`", "emit draft `RateLimit-*` headers"],
        ["`legacyHeaders`", "`false`", "emit legacy `X-RateLimit-*` headers"],
        ["`store`", "a fresh `MemoryStore`", "swap for a shared, Redis, or memcached store"],
        ["`onStoreError`", "`\"open\"`", "`\"open\"` lets requests through if the store throws; `\"closed\"` blocks them"],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "`onStoreError` is the availability-vs-abuse dial. Default `\"open\"` keeps your API up when Redis blips, at the cost of letting a flood slip through. `\"closed\"` blocks every request while the store is down: no flood, but an outage takes the route with it. Pick per route.",
    },
    {
      kind: "paragraph",
      text: "`tcpRateLimit` and `udpRateLimit` share `max`, `windowMs`, `keyGenerator`, `skip`, `store`, and `onStoreError`. The HTTP response options (`statusCode`, `message`, the header flags) don't apply on a raw socket; in their place each takes an `onLimit` hook — `(socket, info)` for TCP, `(msg, rinfo, info)` for UDP.",
    },
    { kind: "heading", id: "stores", text: "Stores" },
    {
      kind: "paragraph",
      text: "A store is where the counters live. The default `MemoryStore` is per-process — fine for a single instance, but each replica behind a load balancer keeps its own count. Use a shared store to enforce one budget across the whole fleet. The Redis and memcached clients are not bundled dependencies: bring your own and pass it in.",
    },
    {
      kind: "table",
      headers: ["Store", "Backend", "Notes"],
      rows: [
        ["`MemoryStore`", "in-process", "default; fixed window, sweeps expired keys, capped at 100k keys"],
        [
          "`RedisStore`",
          "Redis · KeyDB · Valkey · Dragonfly · Upstash",
          "atomic Lua, one round trip, shared counters",
        ],
        ["`MemcachedStore`", "memcached", "`add`+`incr` window; `Retry-After` is approximate"],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`MemoryStore` runs a sweep timer. If you construct one yourself (instead of letting `rateLimit` make its own), call `store.close()` on shutdown to release the interval. Otherwise tests and graceful shutdowns can hang.",
    },
    { kind: "heading", id: "redis", text: "Redis / KeyDB / Valkey / Upstash" },
    {
      kind: "paragraph",
      text: "All speak the Redis protocol, so one store covers them. `RedisStore` runs a fixed Lua script server-side (`INCR` + `PEXPIRE` + `PTTL`): one race-free round trip per hit. The key and window are passed as parameters, nothing is interpolated. `ioredis` matches the expected client shape directly.",
    },
    {
      kind: "code",
      snippet: {
        filename: "redis.ts",
        language: "ts",
        code: `import Redis from "ioredis";
import { rateLimit, RedisStore } from "@usetoki/toki-ratelimiter";

const client = new Redis(process.env.REDIS_URL); // or new Redis({ host: "keydb", port: 6379 })
const store = new RedisStore({ client, prefix: "rl:" }); // prefix defaults to "trl:"

app.post(
  "/api/expensive",
  { preHandler: rateLimit({ max: 100, windowMs: 60_000, store, onStoreError: "closed" }) },
  handler,
);`,
      },
    },
    {
      kind: "paragraph",
      text: "`node-redis` (v4) has a different `eval` signature, so wrap it into the expected shape:",
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
      text: "memcached can't report a key's remaining TTL, so `resetAt` (and thus `Retry-After`) is the full window length: an upper bound, not the exact time left. The counter still expires server-side at the real TTL, so the window itself is correct.",
    },
    {
      kind: "code",
      snippet: {
        filename: "memcached.ts",
        language: "ts",
        code: `import { Client } from "memjs";
import { rateLimit, MemcachedStore } from "@usetoki/toki-ratelimiter";

const mc = Client.create(process.env.MEMCACHED_SERVERS);
const store = new MemcachedStore({
  client: {
    add: (key, value, ttl) => mc.add(key, value, { expires: ttl }),
    incr: async (key, amount) => (await mc.increment(key, amount)).value ?? null,
  },
});

app.use(rateLimit({ max: 300, windowMs: 60_000, store }));`,
      },
    },
    { kind: "heading", id: "custom-store", text: "Custom store" },
    {
      kind: "paragraph",
      text: "Implement the `Store` interface — a single `hit(key, windowMs)` returning `{ count, resetAt }` (sync or async), plus an optional `reset(key)` — to back the limiter with anything: SQL, DynamoDB, a sliding-window log. `count` is the running total for the window; `resetAt` is when it rolls over, in epoch ms.",
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

  // optional: refund a key (e.g. you decided this hit shouldn't have counted)
  async reset(key: string): Promise<void> {
    /* drop the counter */
  }
}`,
      },
    },
  ],
};
