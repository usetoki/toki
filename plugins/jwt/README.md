# @usetoki/toki-jwt

Asymmetric JWT for [toki](https://usetoki.github.io/toki/). Sign and verify **RS/PS/ES/EdDSA**
(and HMAC) with `node:crypto`, plus remote **JWKS** fetch + cache for Auth0 / Cognito / Okta /
Entra. Complements toki's built-in HMAC `jwtAuth`.

```bash
npm install @usetoki/toki-jwt
```

## Verify with a public key

```ts
import { createApp, reply } from "@usetoki/toki";
import { jwtAuth, verifyJwt } from "@usetoki/toki-jwt";

const app = createApp();

app.get(
  "/me",
  { preHandler: jwtAuth({ key: publicKeyPem, algorithms: ["RS256"], issuer: "https://issuer" }) },
  (req) => reply.json(req.user), // the verified payload
);

// or directly
const payload = await verifyJwt(token, publicKeyPem, { algorithms: ["ES256"] });
```

`algorithms` is **required**: the token's `alg` must be in the list. That's the guard against
algorithm-confusion attacks (and `alg: none`).

## Verify against a JWKS

```ts
import { createJwksResolver, jwtAuth } from "@usetoki/toki-jwt";

const jwks = createJwksResolver({ uri: "https://issuer/.well-known/jwks.json" });

app.get("/me", { preHandler: jwtAuth({ key: jwks, algorithms: ["RS256"] }) }, handler);
```

The resolver fetches the key set, caches it by `kid`, and refetches (rate-limited) when a token
presents an unknown `kid`, so rotated keys are picked up.

## Sign

```ts
import { signJwt } from "@usetoki/toki-jwt";

const token = signJwt({ sub: "user-42" }, privateKey, {
  algorithm: "ES256",
  expiresIn: 3600,
  issuer: "https://issuer",
  audience: "api",
});
```

`verifyJwt` checks `exp` / `nbf` (with optional `clockTolerance`) and, when given, `issuer` /
`audience` / `subject`. Keys are PEM strings, `Buffer`s, or `KeyObject`s. Algorithms: `RS256/384/512`,
`PS256/384/512`, `ES256/384/512`, `EdDSA`, `HS256/384/512`.
