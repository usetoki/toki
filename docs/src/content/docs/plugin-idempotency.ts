import type { DocPage } from "../../types";

export const idempotencyPluginPage: DocPage = {
  slug: "plugin-idempotency",
  title: "Idempotency",
  description: "Stripe-style Idempotency-Key dedup and replay over memory, Redis, or memcached.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-idempotency` makes a mutating request safe to retry. Use it on anything that must not happen twice (charging a card, sending an email, placing an order) where a flaky network or an over-eager client might fire the same request again. A request carrying an `Idempotency-Key` runs at most once: the first execution's response is stored, and every later retry with the same key replays it instead of running the handler again.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-idempotency`,
      },
    },
    { kind: "heading", id: "quick-start", text: "Quick start" },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { idempotency } from "@usetoki/toki-idempotency";

const app = createApp();

app.register((api) => {
  idempotency(api); // in-process store; pass { store } for Redis/memcached
  api.post("/charges", async (req) => {
    const charge = await createCharge(req.json());
    return reply.json(charge, 201); // stored; a retry with the same key replays this
  });
});`,
      },
    },
    {
      kind: "paragraph",
      text: "The client picks the key (a UUID is typical) and sends it on every attempt of the same logical request:",
    },
    {
      kind: "code",
      snippet: {
        filename: "request.sh",
        language: "bash",
        code: `curl -X POST https://api.example.com/charges \\
  -H "Idempotency-Key: 5f4e8b2c-1a3d-4e6f-8a9b-0c1d2e3f4a5b" \\
  -H "Content-Type: application/json" \\
  -d '{ "amount": 4200, "currency": "usd" }'`,
      },
    },
    { kind: "heading", id: "behavior", text: "How a retry resolves" },
    {
      kind: "table",
      headers: ["Situation", "Response"],
      rows: [
        [
          "Same key, same request, first attempt finished",
          "the stored response, plus `Idempotent-Replayed: true`",
        ],
        ["Same key, first attempt still running", "`409 Conflict`"],
        ["Same key, but method/path/query/body differ", "`422 Unprocessable Entity`"],
        ["First attempt returned a 5xx", "nothing stored — the key stays retryable"],
      ],
    },
    {
      kind: "paragraph",
      text: "The fingerprint covers method, path, query, and body — so the same key reused for a different request is caught rather than silently replaying the wrong response. Applies to `POST`/`PUT`/`PATCH`/`DELETE` by default. A short in-flight lock keeps a crashed request from wedging the key forever.",
    },
    { kind: "heading", id: "required", text: "Require the header" },
    {
      kind: "paragraph",
      text: "Set `required: true` to reject a participating method with `400` when the `Idempotency-Key` header is missing. Useful when every write on a scope must be idempotent.",
    },
    {
      kind: "code",
      snippet: {
        filename: "required.ts",
        language: "ts",
        code: `app.register((api) => {
  idempotency(api, { required: true, ttl: 3600 }); // keep replays for 1 hour
  api.post("/orders", (req) => placeOrder(req.json()));
});`,
      },
    },
    { kind: "heading", id: "stores", text: "Stores" },
    {
      kind: "paragraph",
      text: "In-process by default: capped (the key is attacker-controlled, so a flood of unique keys can't grow memory without bound) and swept. For more than one instance you want a shared store so a retry that lands on a different node still dedups. Both shared stores reserve the key atomically (Redis `SET NX`, memcached `add`), so two concurrent retries can't both run.",
    },
    {
      kind: "code",
      snippet: {
        filename: "redis.ts",
        language: "ts",
        code: `import Redis from "ioredis";
import { idempotency, RedisStore } from "@usetoki/toki-idempotency";

const redis = new Redis(process.env.REDIS_URL);
idempotency(api, { store: new RedisStore({ client: redis }) });`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "memcached.ts",
        language: "ts",
        code: `import memjs from "memjs";
import { idempotency, MemcachedStore } from "@usetoki/toki-idempotency";

const mc = memjs.Client.create(process.env.MEMCACHED_SERVERS);

// thin wrapper to match the MemcachedClient surface (note the atomic add)
const client = {
  async get(key: string) {
    const { value } = await mc.get(key);
    return value ? value.toString() : null;
  },
  async add(key: string, value: string, ttlSeconds: number) {
    return mc.add(key, value, { expires: ttlSeconds });
  },
  async set(key: string, value: string, ttlSeconds: number) {
    await mc.set(key, value, { expires: ttlSeconds });
  },
  async delete(key: string) {
    await mc.delete(key);
  },
};

idempotency(api, { store: new MemcachedStore({ client }) });`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "What it does"],
      rows: [
        [
          "`store`",
          "`IdempotencyStore`",
          "`MemoryStore()`",
          "Where reservations and records live.",
        ],
        ["`header`", "`string`", '`"idempotency-key"`', "Header carrying the key."],
        [
          "`methods`",
          "`string[]`",
          '`["POST", "PATCH", "PUT", "DELETE"]`',
          "Methods that participate.",
        ],
        [
          "`required`",
          "`boolean`",
          "`false`",
          "Reject participating methods with `400` if absent.",
        ],
        [
          "`ttl`",
          "`number`",
          "`86400`",
          "How long a completed response stays replayable, seconds.",
        ],
        ["`lockTtl`", "`number`", "`60`", "How long one in-flight request holds the key, seconds."],
      ],
    },
    {
      kind: "table",
      headers: ["MemoryStore option", "Default", "What it does"],
      rows: [
        ["`maxKeys`", "`100000`", "Hard ceiling on stored keys; oldest are evicted past it."],
        ["`sweepMs`", "`60000`", "How often expired slots are swept, in ms."],
      ],
    },
    { kind: "heading", id: "notes", text: "Notes" },
    {
      kind: "callout",
      tone: "warning",
      text: "The same key reused with a different method/path/query/body returns `422` — it does not run. Scope a key to one logical request and generate a fresh one per operation.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Handler-staged headers are captured and replayed too (minus `Set-Cookie`), so a retry sees the same `Location`/custom headers as the original.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "5xx responses are never stored, so a failed write stays retryable. If the store write itself fails, the response still goes out and the lock TTL frees the key.",
    },
  ],
};
