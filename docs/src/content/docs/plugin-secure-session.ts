import type { DocPage } from "../../types";

export const secureSessionPluginPage: DocPage = {
  slug: "plugin-secure-session",
  title: "Secure session",
  description: "Stateless sessions sealed into an encrypted AES-256-GCM cookie — no server store.",
  blocks: [
    {
      kind: "paragraph",
      text: "The whole session lives in one encrypted cookie (AES-256-GCM). There's no server-side store to run, nothing to revoke, and nothing to share between instances — every box can read the session because the key is the only state. Reach for it on small sessions and horizontally-scaled apps where you'd rather not stand up Redis just to remember a user id.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-secure-session`,
      },
    },
    { kind: "heading", id: "quick-start", text: "Quick start" },
    {
      kind: "paragraph",
      text: "Call `secureSession(scope, options)` on the app (or any plugin scope) and every route under it gets `req.session`. The cookie is only (re-)issued when the session actually changes, so reads stay free.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { secureSession } from "@usetoki/toki-secure-session";

const app = createApp();
secureSession(app, { secret: process.env.SESSION_SECRET! }); // every route gets req.session

app.post("/login", (req) => {
  req.session.set("userId", 42); // sealed into the response cookie
  return reply.text("ok");
});

app.get("/me", (req) => reply.json({ userId: req.session.get("userId") ?? null }));

app.post("/logout", (req) => {
  req.session.destroy(); // clears the cookie
  return reply.text("bye");
});

app.listen(3000);`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "The secret must be at least 16 bytes. Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` and keep it out of source.",
    },
    { kind: "heading", id: "the-session-api", text: "The session API" },
    {
      kind: "paragraph",
      text: "`req.session` is the same shape as the stateful `@usetoki/toki-session` plugin, so you can swap stores later without touching handlers.",
    },
    {
      kind: "table",
      headers: ["Method", "Does"],
      rows: [
        ["`get<T>(key)`", "read a value (`undefined` if absent); objects come back as a copy"],
        ["`set(key, value)`", "write a value and mark the session dirty"],
        ["`delete(key)`", "remove a key"],
        ["`has(key)`", "test for a key"],
        ["`regenerate()`", "drop every key and re-seal a fresh cookie"],
        ["`destroy()`", "clear the session and remove the cookie"],
        ["`data`", "read-only snapshot of the whole session object"],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`get()` returns a copy of objects, so mutating that copy does NOT persist — only `set()` marks the session dirty and re-seals the cookie. `session.get(\"cart\").items.push(x)` is a no-op on the next request; read, mutate, then `set` it back.",
    },
    { kind: "heading", id: "key-rotation", text: "Key rotation" },
    {
      kind: "paragraph",
      text: "Pass an array of secrets to rotate keys without logging everyone out. The first secret seals new cookies; the rest only verify, so old cookies keep working until they're rewritten or expire. Rotate by prepending a new secret and dropping the oldest once its sessions have aged out.",
    },
    {
      kind: "code",
      snippet: {
        filename: "rotation.ts",
        language: "ts",
        code: `secureSession(app, {
  secret: [
    process.env.SESSION_SECRET_CURRENT!, // seals + verifies
    process.env.SESSION_SECRET_PREVIOUS!, // verifies only (rotated out)
  ],
});`,
      },
    },
    { kind: "heading", id: "expiry-and-rolling", text: "Expiry and rolling sessions" },
    {
      kind: "paragraph",
      text: "`maxAge` is the lifetime in seconds (default one day) and is enforced both in the cookie attributes and inside the sealed payload, so a re-dated cookie can't outlive its server-side expiry. Set `rolling: true` to slide the window forward on every response — handy for \"keep me signed in while active\" without an absolute timeout you have to babysit.",
    },
    {
      kind: "code",
      snippet: {
        filename: "rolling.ts",
        language: "ts",
        code: `secureSession(app, {
  secret: process.env.SESSION_SECRET!,
  maxAge: 60 * 30, // 30 minutes
  rolling: true,   // every response pushes expiry 30 min out
  cookie: { name: "sid", sameSite: "Strict", secure: true },
});`,
      },
    },
    { kind: "heading", id: "scoping", text: "Scoping to part of the app" },
    {
      kind: "paragraph",
      text: "Because it installs onRequest + onSend hooks, you can confine sessions to one branch of the app by calling it inside a registered plugin — routes outside that scope never pay for it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "scoped.ts",
        language: "ts",
        code: `app.register((dash) => {
  secureSession(dash, { secret: process.env.SESSION_SECRET! });
  dash.get("/", (req) => reply.json({ user: req.session.get("userId") ?? null }));
}, { prefix: "/dashboard" });

// routes outside /dashboard have no req.session and no cookie work`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Notes"],
      rows: [
        [
          "`secret`",
          "`string \\| string[] \\| Buffer \\| Buffer[]`",
          "—",
          "required; each ≥ 16 bytes. First is current, the rest verify-only for rotation.",
        ],
        [
          "`maxAge`",
          "`number`",
          "`86400`",
          "lifetime in seconds; must be > 0 (it throws on 0 or negative).",
        ],
        [
          "`rolling`",
          "`boolean`",
          "`false`",
          "re-issue the cookie on every response to slide the expiry.",
        ],
        [
          "`cookie.name`",
          "`string`",
          "`\"session\"`",
          "cookie name.",
        ],
        [
          "`cookie.path`",
          "`string`",
          "`\"/\"`",
          "cookie path.",
        ],
        [
          "`cookie.httpOnly`",
          "`boolean`",
          "`true`",
          "hide the cookie from `document.cookie`.",
        ],
        [
          "`cookie.sameSite`",
          "`\"Strict\" \\| \"Lax\" \\| \"None\"`",
          "`\"Lax\"`",
          "CSRF posture; `\"None\"` requires `secure: true`.",
        ],
        [
          "`cookie.secure`",
          "`boolean`",
          "—",
          "only send over HTTPS; set it in production.",
        ],
        [
          "`cookie.domain`",
          "`string`",
          "—",
          "scope the cookie to a domain.",
        ],
        [
          "`cookie.partitioned`",
          "`boolean`",
          "—",
          "opt into partitioned (CHIPS) storage.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Browsers cap a cookie near 4 KB and silently drop anything larger. If a sealed session would cross that limit, `secureSession` throws on save instead of letting the cookie vanish — that's your signal to move to `@usetoki/toki-session` with a server-side store. Keep the cookie to an id and a few flags, not a shopping cart.",
    },
    { kind: "heading", id: "vs-toki-session", text: "Secure session vs. toki-session" },
    {
      kind: "table",
      headers: ["", "toki-secure-session", "toki-session"],
      rows: [
        ["Where data lives", "encrypted cookie", "server store (memory / Redis / memcached)"],
        ["Server state", "none", "yes"],
        ["Size limit", "~4 KB", "store-bound"],
        ["Revoke server-side", "no (must expire)", "yes"],
        ["Scaling", "stateless — any box reads it", "needs a shared store"],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Both plugins expose the identical `req.session` API, so start stateless and switch to `@usetoki/toki-session` the day a session outgrows the cookie or you need to kill a session from the server.",
    },
  ],
};
