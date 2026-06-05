# Examples

One runnable file per feature. Each builds an app, exercises the feature, checks
the result with `node:assert`, prints a line, and exits — so they double as smoke
tests. Build first (`npm run build`), then run any of them:

```sh
node examples/routing.ts
```

| File | Shows |
|---|---|
| `routing.ts` | methods, `:params`, `*` wildcard, `route()` |
| `async-handlers.ts` | async handlers returning a Promise |
| `hooks-and-middleware.ts` | `use` + every `addHook` phase, short-circuit guard |
| `groups.ts` | `group(prefix, …)` with scoped middleware |
| `plugins.ts` | `register` + encapsulation + prefix + `ready()` |
| `validation.ts` | route schema + custom messages + response serialization |
| `cookies.ts` | `setCookie`/`clearCookie`/`req.cookies` |
| `static-files.ts` | `static()` with ETag/304 |
| `forms.ts` | urlencoded + multipart (`req.form`) |
| `cors-and-security.ts` | `cors()` + `securityHeaders()` |
| `compression.ts` | dynamic `compression()` + `Accept-Encoding` |
| `rate-limit.ts` | native per-IP limiter → `429` |
| `jwt-auth.ts` | `signJwt` + `jwtAuth`-guarded route |
| `content-type-parser.ts` | `addContentTypeParser` + `req.parseBody()` |
| `streaming-sse.ts` | `reply.stream` as `text/event-stream` |
| `inject-testing.ts` | `app.inject()` without a public port |
| `error-and-not-found.ts` | `setErrorHandler` + `setNotFoundHandler` |
| `decorators.ts` | `decorate` (app) + `decorateRequest` (per request) |
| `config-and-shutdown.ts` | listen options + graceful `close()` |
| `reply-builders.ts` | `reply.text/html/json/empty/redirect/bytes` + req introspection |
