import type { DocPage } from "../../types";

export const jwtPluginPage: DocPage = {
  slug: "plugin-jwt",
  title: "JWT (asymmetric + JWKS)",
  description: "Sign and verify RS/PS/ES/EdDSA JWTs, with remote JWKS for Auth0/Cognito/Okta.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-jwt` verifies and signs asymmetric JWTs (RS/PS/ES/EdDSA, plus HMAC) with `node:crypto`, and resolves keys from a remote JWKS by `kid`. It complements toki's built-in HMAC `jwtAuth` for identity providers like Auth0, Cognito, Okta, and Entra.",
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
      kind: "code",
      snippet: {
        filename: "verify.ts",
        language: "ts",
        code: `import { jwtAuth, verifyJwt } from "@usetoki/toki-jwt";

app.get(
  "/me",
  { preHandler: jwtAuth({ key: publicKeyPem, algorithms: ["RS256"], issuer: "https://issuer" }) },
  (req) => req.user, // the verified payload
);

// or directly
const payload = await verifyJwt(token, publicKeyPem, { algorithms: ["ES256"] });`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`algorithms` is required — the token's `alg` must be one of them. That's the guard against algorithm-confusion attacks and `alg: none`.",
    },
    { kind: "heading", id: "jwks", text: "Verify against a JWKS" },
    {
      kind: "code",
      snippet: {
        filename: "jwks.ts",
        language: "ts",
        code: `import { createJwksResolver, jwtAuth } from "@usetoki/toki-jwt";

const jwks = createJwksResolver({ uri: "https://issuer/.well-known/jwks.json" });

app.get("/me", { preHandler: jwtAuth({ key: jwks, algorithms: ["RS256"] }) }, handler);`,
      },
    },
    {
      kind: "paragraph",
      text: "The resolver fetches the key set, caches it by `kid`, and refetches (rate-limited) on an unknown `kid`, so rotated keys are picked up automatically.",
    },
    { kind: "heading", id: "sign", text: "Sign" },
    {
      kind: "code",
      snippet: {
        filename: "sign.ts",
        language: "ts",
        code: `import { signJwt } from "@usetoki/toki-jwt";

const token = signJwt({ sub: "user-42" }, privateKey, {
  algorithm: "ES256",
  expiresIn: 3600,
  issuer: "https://issuer",
  audience: "api",
});`,
      },
    },
  ],
};
