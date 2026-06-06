import type { DocPage } from "../../types";

export const jwtPluginPage: DocPage = {
  slug: "plugin-jwt",
  title: "JWT (asymmetric + JWKS)",
  description: "Sign and verify RS/PS/ES/EdDSA JWTs, with remote JWKS for Auth0/Cognito/Okta.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-jwt` signs and verifies JWTs with `node:crypto` — the asymmetric families (RS, PS, ES, EdDSA) plus HMAC (HS) — and resolves verification keys from a remote JWKS by `kid`. Reach for it when an identity provider issues your tokens (Auth0, Cognito, Okta, Entra) and you verify them with a rotating public key set, or when you sign your own tokens with a private key. It's the asymmetric/JWKS counterpart to toki's built-in HMAC `jwtAuth`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-jwt`,
      },
    },
    { kind: "heading", id: "verify", text: "Verify with a public key" },
    {
      kind: "paragraph",
      text: "`jwtAuth` is a middleware: it reads the `Authorization: Bearer` token, verifies it, and attaches the payload to `req.user`. A failed verification replies `401` with a `WWW-Authenticate: Bearer` header.",
    },
    {
      kind: "code",
      snippet: {
        filename: "verify.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { jwtAuth, verifyJwt } from "@usetoki/toki-jwt";

const app = createApp();

app.get(
  "/me",
  {
    preHandler: jwtAuth({
      key: publicKeyPem,
      algorithms: ["RS256"],
      issuer: "https://issuer.example.com",
      audience: "api",
    }),
  },
  (req) => reply.json(req.user), // the verified payload
);

// or verify a token directly, outside a route
const payload = await verifyJwt(token, publicKeyPem, { algorithms: ["ES256"] });`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`algorithms` is required and is your security boundary. The token's `alg` header must be one of the values you list — that's what blocks the algorithm-confusion attack and `alg: none`. Never widen it to \"all the algorithms\"; list exactly what your issuer signs with.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "An HMAC algorithm (`HS256`/`384`/`512`) refuses a PEM or asymmetric `KeyObject` as its secret — passing a published RSA public key where an HMAC secret is expected is the classic key-confusion forgery, and the plugin throws instead of accepting it. Use a real shared secret for HMAC, and RS/PS/ES/EdDSA for public-key verification.",
    },
    { kind: "heading", id: "jwks", text: "Verify against a JWKS" },
    {
      kind: "paragraph",
      text: "For providers that publish a JWKS, pass a resolver as `key`. It fetches the key set, caches it by `kid`, and refetches (rate-limited) when a token presents an unknown `kid` — so a rotated signing key is picked up without a redeploy.",
    },
    {
      kind: "code",
      snippet: {
        filename: "jwks.ts",
        language: "ts",
        code: `import { createJwksResolver, jwtAuth } from "@usetoki/toki-jwt";

const jwks = createJwksResolver({
  uri: "https://issuer.example.com/.well-known/jwks.json",
  cacheMaxAge: 600_000, // trust the cached set for 10 min
  cooldown: 30_000, // min gap between refetches on an unknown kid
});

app.get(
  "/me",
  {
    preHandler: jwtAuth({
      key: jwks,
      algorithms: ["RS256"],
      issuer: "https://issuer.example.com/",
      audience: "https://api.example.com",
    }),
  },
  (req) => reply.json(req.user),
);`,
      },
    },
    { kind: "heading", id: "sign", text: "Sign" },
    {
      kind: "paragraph",
      text: "`signJwt` builds and signs a token. It sets `iat` for you; `expiresIn`/`notBefore` are offsets in seconds from now. `keyid` writes the `kid` header so a verifier's JWKS can pick the matching key.",
    },
    {
      kind: "code",
      snippet: {
        filename: "sign.ts",
        language: "ts",
        code: `import { signJwt } from "@usetoki/toki-jwt";

const token = signJwt({ sub: "user-42", role: "admin" }, privateKeyPem, {
  algorithm: "ES256",
  expiresIn: 3600, // exp = now + 1h
  issuer: "https://issuer.example.com",
  audience: "api",
  keyid: "2026-06", // -> kid header
});`,
      },
    },
    { kind: "heading", id: "decorate", text: "Custom token source & target" },
    {
      kind: "paragraph",
      text: "By default `jwtAuth` reads the bearer header and writes `req.user`. Override `getToken` to read from a cookie or query, and `decorateAs` to land the payload somewhere else.",
    },
    {
      kind: "code",
      snippet: {
        filename: "cookie-jwt.ts",
        language: "ts",
        code: `app.get(
  "/dashboard",
  {
    preHandler: jwtAuth({
      key: jwks,
      algorithms: ["RS256"],
      getToken: (req) => req.cookies["session"] ?? null,
      decorateAs: "claims", // payload -> req.claims
      clockTolerance: 5, // seconds of leeway on exp/nbf
    }),
  },
  (req) => reply.json((req as { claims?: unknown }).claims),
);`,
      },
    },
    { kind: "heading", id: "algorithms", text: "Algorithms" },
    {
      kind: "table",
      headers: ["Family", "Algorithms", "Key on verify"],
      rows: [
        ["HMAC", "`HS256` `HS384` `HS512`", "Shared secret (string/Buffer) — never a PEM"],
        ["RSA (PKCS#1)", "`RS256` `RS384` `RS512`", "RSA public key"],
        ["RSA-PSS", "`PS256` `PS384` `PS512`", "RSA public key"],
        ["ECDSA", "`ES256` `ES384` `ES512`", "EC public key (signature is raw r‖s)"],
        ["EdDSA", "`EdDSA`", "Ed25519/Ed448 public key"],
      ],
    },
    { kind: "heading", id: "verify-options", text: "verifyJwt / jwtAuth options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Notes"],
      rows: [
        ["`algorithms`", "`JwtAlgorithm[]`", "— (required)", "Token `alg` must be in this list."],
        ["`issuer`", "`string \\| string[]`", "—", "Validates the `iss` claim."],
        ["`audience`", "`string \\| string[]`", "—", "Validates the `aud` claim."],
        ["`subject`", "`string`", "—", "Validates the `sub` claim."],
        ["`clockTolerance`", "`number`", "`0`", "Seconds of leeway for `exp`/`nbf`."],
        [
          "`key`",
          "`KeyInput \\| KeyResolver`",
          "— (jwtAuth)",
          "Public key, HMAC secret, or a JWKS resolver.",
        ],
        ["`getToken`", "`(req) => string \\| null`", "Bearer header", "jwtAuth only."],
        ["`decorateAs`", "`string`", "`\"user\"`", "jwtAuth: request property for the payload."],
        ["`onUnauthorized`", "`(req, err) => HandlerResult`", "401 JSON", "jwtAuth only."],
      ],
    },
    { kind: "heading", id: "sign-options", text: "signJwt options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Notes"],
      rows: [
        ["`algorithm`", "`JwtAlgorithm`", "Required; drives the `alg` header and the signature."],
        ["`expiresIn`", "`number`", "Seconds until `exp`. Must be finite."],
        ["`notBefore`", "`number`", "Seconds until `nbf`. Must be finite."],
        ["`issuer` / `audience` / `subject`", "`string` / …", "Sets `iss` / `aud` / `sub`."],
        ["`keyid`", "`string`", "Sets the `kid` header."],
        ["`header`", "`Record<string, unknown>`", "Extra header fields (`alg`/`typ` stay authoritative)."],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "`createJwksResolver` only imports keys node can build (`createPublicKey({ key, format: \"jwk\" })`); unsupported `kty` entries are skipped rather than throwing the whole fetch. A JWK whose `kid` is missing is stored under the empty-string key.",
    },
  ],
};
