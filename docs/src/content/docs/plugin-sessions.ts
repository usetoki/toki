import type { DocPage } from "../../types";

export const sessionsPluginPage: DocPage = {
  slug: "plugin-sessions",
  title: "Sessions",
  description: "Stateful sessions with a store, or stateless encrypted-cookie sessions.",
  blocks: [
    {
      kind: "paragraph",
      text: "Two session plugins, same `req.session` API. Pick stateless (everything in an encrypted cookie, no store) or stateful (a signed id cookie + a server-side store). Both attach to a scope, so call them on the app.",
    },
    {
      kind: "table",
      headers: ["Package", "Where the data lives", "Use when"],
      rows: [
        [
          "`@usetoki/toki-secure-session`",
          "encrypted cookie (AES-256-GCM)",
          "small sessions, no infra, easy scaling",
        ],
        [
          "`@usetoki/toki-session`",
          "a store (memory / Redis / memcached)",
          "larger sessions, or you need to revoke server-side",
        ],
      ],
    },
    { kind: "heading", id: "stateful", text: "Stateful — toki-session" },
    {
      kind: "code",
      snippet: {
        filename: "session.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { session } from "@usetoki/toki-session";

const app = createApp();
session(app, { secret: process.env.SESSION_SECRET! }); // in-memory store by default

app.post("/login", (req) => {
  req.session.regenerate();           // new id on login — stops session fixation
  req.session.set("userId", 42);
  return reply.text("ok");
});

app.get("/me", (req) => reply.json({ userId: req.session.get("userId") ?? null }));
app.post("/logout", (req) => {
  req.session.destroy();
  return reply.text("bye");
});`,
      },
    },
    {
      kind: "paragraph",
      text: "Bring your own store client. `MemoryStore` (default), `RedisStore` (Redis · KeyDB · Valkey · Upstash), and `MemcachedStore` ship in the box; implement the `SessionStore` interface (`get` / `set` / `destroy` / optional `touch`) for anything else.",
    },
    {
      kind: "code",
      snippet: {
        filename: "redis.ts",
        language: "ts",
        code: `import Redis from "ioredis";
import { RedisStore } from "@usetoki/toki-session";

session(app, { secret, store: new RedisStore({ client: new Redis(process.env.REDIS_URL) }) });`,
      },
    },
    { kind: "heading", id: "stateless", text: "Stateless — toki-secure-session" },
    {
      kind: "code",
      snippet: {
        filename: "secure-session.ts",
        language: "ts",
        code: `import { secureSession } from "@usetoki/toki-secure-session";

secureSession(app, { secret: process.env.SESSION_SECRET! });

app.post("/login", (req) => {
  req.session.set("userId", 42); // sealed into the cookie on the response
  return "ok";
});`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "`req.session`: get · set · delete · has · regenerate · destroy · data. The cookie is only (re-)written when the session changes. A stateless session over the ~4KB cookie limit throws on save — move to toki-session.",
    },
  ],
};
