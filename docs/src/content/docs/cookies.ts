import type { DocPage } from "../../types";

export const cookiesPage: DocPage = {
  slug: "cookies",
  title: "Cookies",
  description: "Reading the Cookie header and setting Set-Cookie with the standard attributes.",
  blocks: [
    {
      kind: "paragraph",
      text: "Read incoming cookies from `req.cookies` and write them with `req.setCookie` / `req.clearCookie`. Reads are lazy and writes are staged as `Set-Cookie` headers, so a handler that touches no cookies pays nothing.",
    },
    { kind: "heading", id: "reading", text: "Reading cookies" },
    {
      kind: "paragraph",
      text: "Cookies from the request's `Cookie` header are parsed on first access and exposed as a frozen, null-prototype record on `req.cookies`. Values are URL-decoded; an absent key reads as `undefined`. Duplicate names keep the first. A cookie literally named `__proto__` or `constructor` is stored as a plain key and cannot reach the prototype chain.",
    },
    {
      kind: "code",
      snippet: {
        filename: "read.ts",
        language: "ts",
        code: `app.get("/me", (req) => {
  const session = req.cookies.session; // string | undefined
  if (session === undefined) return reply.empty(401);
  return reply.json({ session });
});`,
      },
    },
    { kind: "heading", id: "setting", text: "Setting cookies" },
    {
      kind: "paragraph",
      text: "`req.setCookie(name, value, options?)` stages one `Set-Cookie` header; the value is URL-encoded for you. Each call appends a header, so several cookies on one response coexist. It throws `TypeError` on an invalid cookie name (only token characters are allowed). The call returns `this`, so writes chain.",
    },
    {
      kind: "code",
      snippet: {
        filename: "set-session.ts",
        language: "ts",
        code: `app.post("/login", (req) => {
  const sid = crypto.randomUUID();
  req.setCookie("session", sid, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24, // one day, in seconds
  });
  return reply.json({ ok: true });
});`,
      },
    },
    {
      kind: "paragraph",
      text: "Set more than one in a row, each its own `Set-Cookie` line:",
    },
    {
      kind: "code",
      snippet: {
        filename: "set-many.ts",
        language: "ts",
        code: `app.post("/prefs", (req) => {
  req
    .setCookie("theme", "dark", { path: "/", maxAge: 31536000 })
    .setCookie("lang", "en", { path: "/", maxAge: 31536000 });
  return reply.empty(204);
});`,
      },
    },
    { kind: "heading", id: "clearing", text: "Clearing cookies" },
    {
      kind: "paragraph",
      text: "`req.clearCookie(name, options?)` expires a cookie by setting it empty with `Max-Age=0` and an epoch `Expires`. Pass the same `path` (and `domain`) you set it with; a browser only removes a cookie when the scope matches.",
    },
    {
      kind: "code",
      snippet: {
        filename: "logout.ts",
        language: "ts",
        code: `app.post("/logout", (req) => {
  req.clearCookie("session", { path: "/" });
  return reply.empty(204);
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`path` defaults to `/` on both set and clear, so a cookie scoped to a subpath (e.g. `path: \"/admin\"`) will not be cleared by a bare `clearCookie(name)` — pass the matching `path`.",
    },
    { kind: "heading", id: "options", text: "Cookie options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Notes"],
      rows: [
        ["`httpOnly`", "`boolean`", "Hide from `document.cookie` (blocks XSS theft)."],
        ["`secure`", "`boolean`", "Only sent over HTTPS."],
        ["`sameSite`", '`"Strict" \\| "Lax" \\| "None"`', "CSRF protection; `None` requires `secure`."],
        ["`path`", "`string`", "Path scope. Always emitted; defaults to `/`."],
        ["`domain`", "`string`", "Domain scope. Omitted unless set."],
        ["`maxAge`", "`number`", "Lifetime in seconds; truncated to an integer."],
        ["`expires`", "`Date`", "Absolute expiry (serialized to a UTC string)."],
        ["`partitioned`", "`boolean`", "Partition by top-level site (CHIPS)."],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "For a session cookie pick `httpOnly`, `secure`, and `sameSite: \"Lax\"` as a sane default. Omit `maxAge`/`expires` to make it a session cookie the browser drops on close.",
    },
    {
      kind: "paragraph",
      text: "Core cookies are unsigned: the value is whatever you write. For tamper-evident, encrypted session cookies use the [secure-session](/docs/plugin-secure-session) plugin, which signs and seals the payload for you.",
    },
    { kind: "heading", id: "standalone", text: "Standalone helpers" },
    {
      kind: "paragraph",
      text: "The underlying functions are exported from `@usetoki/toki` for use outside a request: parsing a stored `Cookie` string, or building a `Set-Cookie` value to attach elsewhere.",
    },
    {
      kind: "code",
      snippet: {
        filename: "standalone.ts",
        language: "ts",
        code: `import { parseCookies, serializeCookie } from "@usetoki/toki";

const jar = parseCookies("session=abc; theme=dark");
// → { session: "abc", theme: "dark" }

const header = serializeCookie("session", "abc", {
  httpOnly: true,
  maxAge: 3600,
});
// → "session=abc; Max-Age=3600; Path=/; HttpOnly"`,
      },
    },
  ],
};
