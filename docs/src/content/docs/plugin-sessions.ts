import type { DocPage } from "../../types";

export const sessionsPluginPage: DocPage = {
  slug: "plugin-sessions",
  title: "Sessions",
  description: "Stateful sessions with a store, or stateless encrypted-cookie sessions.",
  blocks: [
    {
      kind: "paragraph",
      text: "A session keeps per-user state between requests: who's logged in, a cart, a CSRF token. toki ships two session plugins behind the same `req.session` API, so your handlers don't care which one you pick. Reach for the stateless one when sessions are small and you want zero infra; reach for the stateful one when sessions get big, or you need to revoke them server-side.",
    },
    {
      kind: "table",
      headers: ["Package", "Where the data lives", "Reach for it when"],
      rows: [
        [
          "`@usetoki/toki-secure-session`",
          "encrypted cookie (AES-256-GCM)",
          "small sessions, no infra, trivial to scale horizontally",
        ],
        [
          "`@usetoki/toki-session`",
          "a store (memory / Redis / memcached)",
          "larger sessions, or you need to revoke from the server",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Both plugins attach to a scope via a hook, so call them on the app (or any sub-scope) and every route under it gets `req.session`. The API is identical: get · set · delete · has · regenerate · destroy · data.",
    },

    { kind: "heading", id: "stateful", text: "Stateful — toki-session" },
    {
      kind: "paragraph",
      text: "A signed session id rides in a cookie; the data lives in a store you control. The id cookie is HMAC-signed, not encrypted. It carries no secrets, just a random id pointing at the stored data.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-session`,
      },
    },
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
  req.session.regenerate();          // fresh id on login — kills session fixation
  req.session.set("userId", 42);
  return reply.text("ok");
});

app.get("/me", (req) =>
  reply.json({ userId: req.session.get<number>("userId") ?? null }),
);

app.post("/logout", (req) => {
  req.session.destroy();             // drops it from the store + clears the cookie
  return reply.text("bye");
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Always `regenerate()` right after you authenticate a user. It rotates to a brand-new id and drops the old one from the store, so a session id an attacker planted before login is worthless after.",
    },

    { kind: "heading", id: "stores", text: "Stores" },
    {
      kind: "paragraph",
      text: "The default `MemoryStore` is single-process: fine for one box, useless behind a load balancer. For anything that scales out, point the session at a shared store. `RedisStore` and `MemcachedStore` ship in the box; for anything else, implement the `SessionStore` interface (`get` / `set` / `destroy`, plus an optional `touch` for rolling sessions).",
    },
    {
      kind: "code",
      snippet: {
        filename: "redis.ts",
        language: "ts",
        code: `import Redis from "ioredis";
import { session, RedisStore } from "@usetoki/toki-session";

// ioredis (also KeyDB / Valkey / Upstash) matches the client surface directly.
const store = new RedisStore({ client: new Redis(process.env.REDIS_URL!) });

session(app, {
  secret: process.env.SESSION_SECRET!,
  store,
  maxAge: 60 * 60 * 24 * 7, // a week, in seconds
});`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "memcached.ts",
        language: "ts",
        code: `import { Client } from "memjs";
import { session, MemcachedStore, type MemcachedClient } from "@usetoki/toki-session";

// memjs returns Buffers; adapt it to the small string-in/string-out surface the store wants.
const mc = Client.create();
const client: MemcachedClient = {
  async get(key) {
    const r = await mc.get(key);
    return r.value ? r.value.toString("utf8") : null;
  },
  async set(key, value, ttlSeconds) {
    await mc.set(key, value, { expires: ttlSeconds });
  },
  async delete(key) {
    await mc.delete(key);
  },
};

session(app, { secret: process.env.SESSION_SECRET!, store: new MemcachedStore({ client }) });`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "`MemoryStore` is capacity-capped (100k sessions by default) and sweeps expired entries on a timer, so a client can't exhaust memory by minting a new session per request. memcached caps any TTL over 30 days, since it reads larger values as absolute timestamps.",
    },

    { kind: "heading", id: "rolling", text: "Rolling expiry" },
    {
      kind: "paragraph",
      text: "By default the cookie's expiry is fixed from when the session was created. Set `rolling: true` to slide it forward on every response, so an active user never gets logged out mid-session. The store TTL and the cookie are both re-issued each request.",
    },
    {
      kind: "code",
      snippet: {
        filename: "rolling.ts",
        language: "ts",
        code: `session(app, {
  secret: process.env.SESSION_SECRET!,
  store,
  maxAge: 60 * 30, // 30 minutes of inactivity...
  rolling: true,   // ...reset on every request
});`,
      },
    },

    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Field", "Type", "Default", "Notes"],
      rows: [
        [
          "`secret`",
          "`string \\| string[] \\| Buffer \\| Buffer[]`",
          "—",
          "Signs the id cookie. Each secret ≥ 16 bytes. Pass an array to rotate (newest first).",
        ],
        ["`store`", "`SessionStore`", "`new MemoryStore()`", "Where session data lives."],
        ["`maxAge`", "`number`", "`86400`", "Lifetime in seconds. Must be > 0."],
        [
          "`rolling`",
          "`boolean`",
          "`false`",
          "Re-issue cookie + touch the store each response to slide expiry.",
        ],
        ["`cookie.name`", "`string`", "`\"sid\"`", "Name of the id cookie."],
        [
          "`cookie.sameSite`",
          "`\"Strict\" \\| \"Lax\" \\| \"None\"`",
          "`\"Lax\"`",
          "`\"None\"` requires `secure: true`.",
        ],
        [
          "`cookie.secure`",
          "`boolean`",
          "—",
          "HTTPS-only cookie. Turn it on in production.",
        ],
        [
          "`cookie.httpOnly`",
          "`boolean`",
          "`true`",
          "Hides the cookie from JS — keep it on.",
        ],
        ["`cookie.path` / `cookie.domain`", "`string`", "`path: \"/\"`", "Cookie scope."],
      ],
    },

    { kind: "heading", id: "stateless", text: "Stateless — toki-secure-session" },
    {
      kind: "paragraph",
      text: "No store, no id — the whole session is encrypted (AES-256-GCM) and stuffed into the cookie itself. Every node can read it with the same secret, so it scales horizontally with zero coordination. The trade-off: you can't revoke a session server-side (the client holds it), and you're bound by the browser's ~4KB cookie limit.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-secure-session`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "secure-session.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { secureSession } from "@usetoki/toki-secure-session";

const app = createApp();
secureSession(app, {
  secret: process.env.SESSION_SECRET!,
  cookie: { secure: true, sameSite: "Strict" },
});

app.post("/login", (req) => {
  req.session.set("userId", 42); // sealed into the cookie on the response
  return reply.text("ok");
});

app.get("/me", (req) =>
  reply.json({ userId: req.session.get<number>("userId") ?? null }),
);`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "A stateless session that grows past the ~4KB cookie limit throws when toki tries to save it. Keep cookie sessions to ids and flags; if you need to store more, switch to toki-session with a store. `regenerate()` here just resets the data and forces a re-encrypt. There's no server id to rotate.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "The cookie is only re-written when the session actually changes (or on every response if `rolling: true`). Reads cost nothing on the wire.",
    },
  ],
};
