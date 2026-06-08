import type { DocPage } from "../../types";

export const jwtPage: DocPage = {
  slug: "jwt",
  title: "JWT authentication",
  description: "Sign and verify HMAC JSON Web Tokens and guard routes with jwtAuth.",
  blocks: [
    {
      kind: "paragraph",
      text: "Toki ships small HMAC-SHA JWT helpers in core: `signJwt` and `verifyJwt` for tokens, `jwtAuth` — a middleware that verifies the `Authorization: Bearer` token and attaches the payload to the request — and the `JwtError` thrown on a bad token. Signing runs on `node:crypto`'s native code; supported algorithms are `HS256`, `HS384`, and `HS512`.",
    },
    { kind: "heading", id: "sign-verify", text: "Sign & verify" },
    {
      kind: "paragraph",
      text: "Both functions take the `secret` as a positional argument — `signJwt(payload, secret, options?)` and `verifyJwt(token, secret, options?)`. `signJwt` always stamps `iat`; the rest of the claims come from `options`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "tokens.ts",
        language: "ts",
        code: `import { signJwt, verifyJwt } from "@usetoki/toki";

const secret = process.env.JWT_SECRET!;

const token = signJwt(
  { role: "admin" },
  secret,
  { subject: "user-1", expiresIn: 3600, algorithm: "HS256" }, // expiresIn is SECONDS
);

const payload = verifyJwt(token, secret);
// { iat, sub: "user-1", exp, role: "admin" }`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`expiresIn` and `notBefore` are durations in SECONDS, not strings like `\"1h\"`. `signJwt({...}, secret, { expiresIn: 3600 })` is one hour.",
    },
    { kind: "heading", id: "sign-options", text: "SignOptions" },
    {
      kind: "table",
      headers: ["Option", "Default", "Claim", "Description"],
      rows: [
        ["`algorithm`", "`\"HS256\"`", "—", "`HS256` | `HS384` | `HS512`."],
        ["`expiresIn`", "—", "`exp`", "Seconds until the token expires (added to now)."],
        ["`notBefore`", "—", "`nbf`", "Seconds until the token becomes valid."],
        ["`issuer`", "—", "`iss`", "Token issuer."],
        ["`audience`", "—", "`aud`", "Intended audience — a string or array."],
        ["`subject`", "—", "`sub`", "Token subject (usually a user id)."],
      ],
    },
    { kind: "heading", id: "verify-options", text: "VerifyOptions" },
    {
      kind: "paragraph",
      text: "`verifyJwt` checks the signature, then `exp`/`nbf`, then any claim constraints you pass. It returns the decoded `JwtPayload` or throws.",
    },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        [
          "`algorithms`",
          "any HS*",
          "Allowed algorithms. Restricts which the token may claim — set this to pin one.",
        ],
        ["`issuer`", "—", "Require this exact `iss`."],
        ["`audience`", "—", "Require this value to equal `aud`, or be present when `aud` is an array."],
        ["`clockTolerance`", "`0`", "Clock-skew tolerance in seconds applied to `exp`/`nbf`."],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Pin the algorithm on verify: `verifyJwt(token, secret, { algorithms: [\"HS256\"] })`. The verifier already rejects anything outside the HS* family, but an explicit allowlist is one less thing to reason about.",
    },
    { kind: "heading", id: "login", text: "Issue a token on login" },
    {
      kind: "code",
      snippet: {
        filename: "login.ts",
        language: "ts",
        code: `import { reply, signJwt } from "@usetoki/toki";

app.post("/login", async (req) => {
  const { email, password } = await req.parseBody<{ email: string; password: string }>();
  const user = await users.verify(email, password);
  if (!user) return reply.json({ error: "bad credentials" }, 401);

  const token = signJwt({ role: user.role }, process.env.JWT_SECRET!, {
    subject: user.id,
    expiresIn: 3600,
  });
  return { token };
});`,
      },
    },
    { kind: "heading", id: "guard", text: "Guard routes with jwtAuth" },
    {
      kind: "paragraph",
      text: "`jwtAuth(options)` is a middleware. It pulls the `Authorization: Bearer <token>` value, verifies it, and on success attaches the payload to the request (default `req.user`). A missing or invalid token short-circuits with a `401` JSON body — your handler never runs.",
    },
    {
      kind: "code",
      snippet: {
        filename: "guard.ts",
        language: "ts",
        code: `import { jwtAuth, reply } from "@usetoki/toki";

app.group("/api", (api) => {
  api.use(jwtAuth({ secret: process.env.JWT_SECRET!, algorithms: ["HS256"] }));

  api.get("/me", (req) => {
    const user = (req as { user: { sub?: string; role?: string } }).user;
    return reply.json(user); // payload attached by jwtAuth
  });
});`,
      },
    },
    { kind: "heading", id: "auth-options", text: "JwtAuthOptions" },
    {
      kind: "paragraph",
      text: "`JwtAuthOptions` extends `VerifyOptions`, so every verify constraint above applies. It adds:",
    },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        ["`secret`", "required", "HMAC secret used to verify the signature."],
        [
          "`getToken`",
          "Bearer header",
          "`(req) => string | null` to extract the token elsewhere — e.g. a cookie. Return `null` when absent.",
        ],
        ["`decorateAs`", "`\"user\"`", "Request property the verified payload is attached to."],
      ],
    },
    {
      kind: "heading",
      id: "cookie-token",
      text: "Token from a cookie",
    },
    {
      kind: "paragraph",
      text: "For browser apps you may keep the token in an `HttpOnly` cookie instead of a header. Supply `getToken` to read it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "cookie-auth.ts",
        language: "ts",
        code: `app.use(
  jwtAuth({
    secret: process.env.JWT_SECRET!,
    getToken: (req) => req.cookies["session"] ?? null,
    decorateAs: "auth", // payload lands on req.auth
  }),
);`,
      },
    },
    { kind: "heading", id: "errors", text: "Expiry & errors" },
    {
      kind: "paragraph",
      text: "`verifyJwt` throws a `JwtError` on a malformed, expired (`exp`), not-yet-valid (`nbf`), or wrong-signature/claim token. Catch it to shape your own response; `jwtAuth` already turns it into a `401` whose `message` is the error's message (`\"token expired\"`, `\"invalid signature\"`, …).",
    },
    {
      kind: "code",
      snippet: {
        filename: "verify-catch.ts",
        language: "ts",
        code: `import { JwtError, verifyJwt, reply } from "@usetoki/toki";

app.get("/whoami", (req) => {
  const token = req.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!token) return reply.json({ error: "no token" }, 401);
  try {
    return verifyJwt(token, process.env.JWT_SECRET!, { clockTolerance: 5 });
  } catch (err) {
    if (err instanceof JwtError && err.message === "token expired") {
      return reply.json({ error: "expired" }, 401);
    }
    return reply.json({ error: "invalid" }, 401);
  }
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Keep the secret out of source control — read it from the environment. Tokens are signed, not encrypted: anyone can base64-decode the payload, so never put secrets in it. Use a long, random secret (32+ bytes).",
    },
  ],
};
