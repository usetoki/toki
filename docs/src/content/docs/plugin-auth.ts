import type { DocPage } from "../../types";

export const authPluginPage: DocPage = {
  slug: "plugin-auth",
  title: "Auth",
  description: "Basic, bearer, and API-key strategies composed with anyOf / allOf.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-auth` composes one or more auth strategies into a middleware that sets `req.user` on success, or replies `401` with a `WWW-Authenticate` challenge. Use it as a route `preHandler`, `app.use`, or on a scope.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-auth`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "auth.ts",
        language: "ts",
        code: `import { auth, basic, bearer, apiKey, safeEqual } from "@usetoki/toki-auth";

// a single strategy
app.get(
  "/admin",
  { preHandler: auth(basic((user, pass) => (user === "admin" && safeEqual(pass, secret) ? { user } : null))) },
  (req) => req.user,
);

// any of several
const guard = auth([
  bearer((token) => verifyToken(token)),
  apiKey((key) => lookupKey(key), { query: "api_key" }),
]);
app.get("/data", { preHandler: guard }, (req) => req.user);`,
      },
    },
    {
      kind: "table",
      headers: ["Strategy", "Reads"],
      rows: [
        ["`basic(verify, { realm })`", "`Authorization: Basic`"],
        ["`bearer(verify)`", "`Authorization: Bearer <token>`"],
        ["`apiKey(verify, { header, query })`", "`x-api-key` header (+ optional query)"],
      ],
    },
    {
      kind: "paragraph",
      text: 'A verify callback returns the user (any truthy value) or `null` to reject. `auth(strategies, { mode })` runs `"anyOf"` (default — first to pass wins) or `"allOf"` (every strategy must pass). `safeEqual` is a constant-time compare for passwords and keys.',
    },
    {
      kind: "callout",
      tone: "tip",
      text: "For JWT bearer tokens with asymmetric keys or a JWKS, pair this with [`@usetoki/toki-jwt`](/docs/plugin-jwt).",
    },
  ],
};
