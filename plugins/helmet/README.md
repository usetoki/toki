# @usetoki/toki-helmet

Secure HTTP response headers for [toki](https://usetoki.github.io/toki/), in the
spirit of [helmet](https://helmetjs.github.io). One middleware sets a baseline of
hardening headers (CSP, HSTS, frameguard, `nosniff`, cross-origin policies, and more).
Each is individually configurable, or can be dropped.

```bash
npm install @usetoki/toki-helmet
```

## Usage

```ts
import { createApp } from "@usetoki/toki";
import { helmet } from "@usetoki/toki-helmet";

const app = createApp();

app.use(helmet());

app.get("/", () => "hello");
app.listen(3000);
```

`helmet()` is a plain middleware — use it app-wide (`app.use`), on a scope or group,
or on a single route's `preHandler`. Staged headers ride along on error and
not-found responses too.

## Defaults

| Header | Default |
| --- | --- |
| `Content-Security-Policy` | helmet's baseline policy |
| `Strict-Transport-Security` | `max-age=15552000; includeSubDomains` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `X-Content-Type-Options` | `nosniff` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Origin-Agent-Cluster` | `?1` |
| `Referrer-Policy` | `no-referrer` |
| `X-DNS-Prefetch-Control` | `off` |
| `X-Download-Options` | `noopen` |
| `X-Permitted-Cross-Domain-Policies` | `none` |
| `X-XSS-Protection` | `0` |
| `Cross-Origin-Embedder-Policy` | off (opt in — it blocks cross-origin sub-resources) |

## Configuring

Pass `false` to drop a header, a string to override its value, or a config object
for CSP and HSTS:

```ts
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { scriptSrc: ["'self'", "https://cdn.example"] }, // merges over defaults
    },
    hsts: { maxAge: 31536000, preload: true },
    frameguard: "DENY",
    crossOriginEmbedderPolicy: true, // require-corp
    referrerPolicy: "strict-origin-when-cross-origin",
    xssProtection: false, // drop the header
  }),
);
```

Set `contentSecurityPolicy: { useDefaults: false, directives: {...} }` to start from
an empty policy instead of merging. `buildCsp` and the `DEFAULT_CSP` directives are
exported if you want to compose a policy yourself.
