# @usetoki/toki-auth

Multi-strategy authentication for [toki](https://usetoki.github.io/toki/): HTTP Basic, Bearer,
and API key, composed with `anyOf` / `allOf`. On success it sets `req.user`; on failure a 401
(with `WWW-Authenticate`).

```bash
npm install @usetoki/toki-auth
```

## Usage

```ts
import { createApp, reply } from "@usetoki/toki";
import { auth, basic, bearer, apiKey, safeEqual } from "@usetoki/toki-auth";

const app = createApp();

// one strategy
app.get(
  "/admin",
  { preHandler: auth(basic((user, pass) => (user === "admin" && safeEqual(pass, secret) ? { user } : null))) },
  (req) => reply.json(req.user),
);

// any of several
const guard = auth([
  bearer((token) => verifyToken(token)),
  apiKey((key) => lookupKey(key), { query: "api_key" }),
]);
app.get("/data", { preHandler: guard }, (req) => reply.json(req.user));
```

Use it as a route `preHandler`, `app.use(...)`, or on a scope. A verify callback returns the
user (any truthy value) or `null` to reject. `safeEqual` is a constant-time string compare for
passwords and keys.

## Strategies & composition

| | |
| --- | --- |
| `basic(verify, { realm })` | `Authorization: Basic` |
| `bearer(verify)` | `Authorization: Bearer <token>` |
| `apiKey(verify, { header, query })` | `x-api-key` header (+ optional query) |
| `auth(strategies, { mode })` | `"anyOf"` (default — first to pass wins) or `"allOf"` (every must pass) |

Failures reply `401` by default; pass `onUnauthorized` to customize. For JWT bearer tokens with
asymmetric keys or JWKS, pair this with
[`@usetoki/toki-jwt`](https://www.npmjs.com/package/@usetoki/toki-jwt).
