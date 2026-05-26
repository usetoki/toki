# Changelog

Follows [Keep a Changelog](https://keepachangelog.com/) and [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Native HTTP/1.1 engine — routing, parsing, and I/O run in Rust.
- Native routes (`app.native.text/html/json/route`): pre-rendered to bytes and
  served from the worker pool with no per-request allocation or JS crossing.
  Fixed response headers can be baked in at registration.
- Native dynamic router: `:param` / `*` matching, native `404` and `405` (with
  `Allow`), and auto-HEAD for `GET` routes.
- Hooks (`onRequest` / `preHandler` / `onResponse`), `use()` middleware, and
  `group()` route groups with scoped prefixes and hooks.
- Cookies (`req.cookies`, `reply.cookie`), `cors()`, `securityHeaders()`, a
  pluggable logger, and a per-request `req.id` / `req.log`.
- Native body parsing (`parseForms`): JSON, urlencoded, and `multipart/form-data`.
  Uploads are written to disk with size and extension limits enforced in Rust.
- Native static files (`app.static`): MIME, `ETag` / `304`, `Range`, traversal-safe.
- Native gzip and brotli compression; native routes are pre-compressed once at
  startup. Levels are tunable.
- TLS (`tlsCert` / `tlsKey`) and Unix-domain sockets (`unixPath`).
- Graceful shutdown with bounded draining; configurable limits and timeouts.
- `X-Powered-By: Toki` on every response, overridable or disabled via `poweredBy`.
- Prebuilt per-platform binaries, plus CI and release workflows.
- Runs on Node.js and Bun.

### Performance

- ~160k req/s at ~38 MB RSS on a single thread.
