import type { DocPage } from "../../types";

export const cookiesPage: DocPage = {
  slug: "cookies",
  title: "Cookies",
  description: "Reading the Cookie header and setting Set-Cookie with options.",
  blocks: [
    {
      kind: "paragraph",
      text: "Cookies from the request's `Cookie` header are parsed lazily and exposed as a frozen record on `req.cookies`. An absent key reads as `undefined`.",
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
      text: "`req.setCookie(name, value, options?)` stages a `Set-Cookie` header; `req.clearCookie(name, options?)` expires one. Options cover the standard attributes.",
    },
    {
      kind: "code",
      snippet: {
        filename: "set.ts",
        language: "ts",
        code: `app.post("/login", (req) => {
  req.setCookie("session", "abc123", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24, // seconds
  });
  return reply.json({ ok: true });
});

app.post("/logout", (req) => {
  req.clearCookie("session", { path: "/" });
  return reply.empty(204);
});`,
      },
    },
    { kind: "heading", id: "options", text: "Cookie options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Notes"],
      rows: [
        ["`httpOnly`", "`boolean`", "Hide from `document.cookie`."],
        ["`secure`", "`boolean`", "Only sent over HTTPS."],
        ["`sameSite`", '`"Strict" | "Lax" | "None"`', "CSRF protection."],
        ["`path`", "`string`", "Cookie path scope."],
        ["`domain`", "`string`", "Cookie domain scope."],
        ["`maxAge`", "`number`", "Lifetime in seconds."],
        ["`expires`", "`Date`", "Absolute expiry."],
      ],
    },
    { kind: "heading", id: "standalone", text: "Standalone helpers" },
    {
      kind: "paragraph",
      text: "The underlying `parseCookies(header)` and `serializeCookie(name, value, options)` are exported for use outside a request.",
    },
  ],
};
