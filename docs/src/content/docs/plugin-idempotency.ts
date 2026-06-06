import type { DocPage } from "../../types";

export const idempotencyPluginPage: DocPage = {
  slug: "plugin-idempotency",
  title: "Idempotency",
  description: "Stripe-style Idempotency-Key dedup and replay over memory, Redis, or memcached.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-idempotency` makes a mutating request safe to retry. A request carrying an `Idempotency-Key` runs at most once — the first execution's response is stored and every later retry with the same key replays it instead of running the handler again.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-idempotency`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { idempotency } from "@usetoki/toki-idempotency";

const app = createApp();

app.register((api) => {
  idempotency(api); // in-process store; pass { store } for Redis/memcached
  api.post("/charges", (req) => createCharge(req.json())); // runs once per Idempotency-Key
});`,
      },
    },
    {
      kind: "list",
      items: [
        "A retry with the same key + same body replays the stored response with `Idempotent-Replayed: true`.",
        "A retry still in flight gets `409`; the same key reused with different parameters gets `422`.",
        "Server errors (5xx) are never stored — they stay retryable. A short in-flight lock keeps a crashed request from wedging the key.",
        "Applies to `POST`/`PUT`/`PATCH`/`DELETE` by default; set `required: true` to mandate the header.",
      ],
    },
    {
      kind: "heading",
      id: "stores",
      text: "Stores",
    },
    {
      kind: "paragraph",
      text: "In-process by default. Share state across instances with the Redis or memcached store — bring any ioredis- or memjs-style client:",
    },
    {
      kind: "code",
      snippet: {
        filename: "stores.ts",
        language: "ts",
        code: `import { idempotency, RedisStore, MemcachedStore } from "@usetoki/toki-idempotency";

idempotency(api, { store: new RedisStore({ client: redis }) });
idempotency(api, { store: new MemcachedStore({ client: memcached }) });`,
      },
    },
  ],
};
