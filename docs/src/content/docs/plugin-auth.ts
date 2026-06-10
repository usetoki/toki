import type { DocPage } from "../../types";

export const authPluginPage: DocPage = {
  slug: "plugin-auth",
  title: "Auth",
  description: "Basic, bearer, and API-key strategies composed with anyOf / allOf.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-auth` turns one or more auth strategies into a middleware. On success it sets `req.user` and lets the request through; on failure it replies `401` with a `WWW-Authenticate` challenge. Use it for HTTP Basic, bearer tokens, or API keys without wiring up the header parsing yourself, or to combine strategies (try a bearer token, fall back to an API key) in one line.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-auth`,
      },
    },
    { kind: "heading", id: "quick-start", text: "Quick start" },
    {
      kind: "paragraph",
      text: "A strategy is a verify callback wrapped in `basic`, `bearer`, or `apiKey`. The callback returns the user (any truthy value) or `null` to decline. `auth(...)` is a middleware — use it as a route `preHandler`, pass it to `app.use(...)`, or attach it to a scope.",
    },
    {
      kind: "code",
      snippet: {
        filename: "basic.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { auth, basic, safeEqual } from "@usetoki/toki-auth";

const app = createApp();

app.get(
  "/admin",
  {
    preHandler: auth(
      basic((user, pass) =>
        user === "admin" && safeEqual(pass, process.env.ADMIN_PASS!) ? { user } : null,
      ),
    ),
  },
  (req) => reply.json(req.user),
);`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Compare passwords and keys with `safeEqual`, not `===`. It's a constant-time compare. A plain `===` leaks how many leading characters matched, which opens a timing side-channel.",
    },
    { kind: "heading", id: "bearer", text: "Bearer tokens" },
    {
      kind: "paragraph",
      text: "`bearer` reads `Authorization: Bearer <token>` and hands you the token. Verify it however you like: a session lookup, a database row, an opaque token store.",
    },
    {
      kind: "code",
      snippet: {
        filename: "bearer.ts",
        language: "ts",
        code: `import { auth, bearer } from "@usetoki/toki-auth";

app.get(
  "/me",
  {
    preHandler: auth(
      bearer(async (token) => {
        const session = await sessions.find(token);
        return session?.user ?? null; // null -> 401
      }),
    ),
  },
  (req) => reply.json(req.user),
);`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "For JWT bearer tokens (asymmetric keys like RS/ES/EdDSA, or a remote JWKS) use [`@usetoki/toki-jwt`](/docs/plugin-jwt) instead of hand-rolling verification inside `bearer`.",
    },
    { kind: "heading", id: "api-key", text: "API keys" },
    {
      kind: "paragraph",
      text: "`apiKey` reads the `x-api-key` header by default. Point `header` at a different name, and set `query` to also accept the key as a query parameter (handy for webhooks and `<img>`-style pings that can't set headers).",
    },
    {
      kind: "code",
      snippet: {
        filename: "api-key.ts",
        language: "ts",
        code: `import { auth, apiKey } from "@usetoki/toki-auth";

const guard = auth(
  apiKey((key) => keyring.lookup(key), { header: "x-api-key", query: "api_key" }),
);

app.get("/data", { preHandler: guard }, (req) => reply.json(req.user));`,
      },
    },
    { kind: "heading", id: "compose", text: "Composing strategies" },
    {
      kind: "paragraph",
      text: 'Pass an array to try several strategies. The default mode is `"anyOf"`: the first strategy to return a user wins. Use `"allOf"` to require every strategy to pass (e.g. a valid API key *and* Basic credentials for an internal service).',
    },
    {
      kind: "code",
      snippet: {
        filename: "compose.ts",
        language: "ts",
        code: `import { auth, bearer, apiKey } from "@usetoki/toki-auth";

// anyOf (default): accept a bearer token OR an API key
const anyOf = auth([
  bearer((token) => verifyToken(token)),
  apiKey((key) => keyring.lookup(key), { query: "api_key" }),
]);

// allOf: both must pass
const allOf = auth(
  [bearer((t) => verifyToken(t)), apiKey((k) => keyring.lookup(k))],
  { mode: "allOf" },
);

app.get("/data", { preHandler: anyOf }, (req) => reply.json(req.user));`,
      },
    },
    {
      kind: "paragraph",
      text: "On `anyOf`, `req.user` is whatever the winning strategy returned. On `allOf`, it's the user from the last strategy that ran. Each strategy that carries a challenge (`basic`, `bearer`) appends its own `WWW-Authenticate` header to a 401.",
    },
    { kind: "heading", id: "custom-401", text: "Custom rejection" },
    {
      kind: "paragraph",
      text: "Override the default 401 body with `onUnauthorized` — return a redirect, an HTML login page, or a different shape.",
    },
    {
      kind: "code",
      snippet: {
        filename: "custom.ts",
        language: "ts",
        code: `import { auth, basic } from "@usetoki/toki-auth";

const guard = auth(basic(check), {
  onUnauthorized: () => reply.redirect("/login", 302),
});`,
      },
    },
    { kind: "heading", id: "strategies", text: "Strategies" },
    {
      kind: "table",
      headers: ["Strategy", "Reads", "Options"],
      rows: [
        ["`basic(verify, opts?)`", "`Authorization: Basic`", '`realm` (default `"Restricted"`)'],
        ["`bearer(verify)`", "`Authorization: Bearer <token>`", "—"],
        [
          "`apiKey(verify, opts?)`",
          "`x-api-key` header, optional query",
          '`header` (default `"x-api-key"`), `query`',
        ],
      ],
    },
    { kind: "heading", id: "auth-options", text: "auth() options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Notes"],
      rows: [
        [
          "`mode`",
          '`"anyOf" \\| "allOf"`',
          '`"anyOf"`',
          "`anyOf`: first success wins. `allOf`: every strategy must pass.",
        ],
        [
          "`onUnauthorized`",
          "`(req) => HandlerResult`",
          "401 JSON",
          "Replaces the default `{ statusCode, error, message }` body.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "A verify callback that returns `null` *or* `undefined` is treated as a decline. Return a truthy value — an object, an id, anything — for the authenticated user, and that value lands on `req.user`.",
    },
  ],
};
