# Changelog

Follows [Keep a Changelog](https://keepachangelog.com/) and [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Native HTTP/1.1 engine written in Zig, running single-threaded on Node's own
  libuv loop — parsing, routing, and I/O stay in native code, handlers stay in JS,
  and there is no thread hop between them.
- Routing: exact O(1) map plus dynamic `:param` / `*` matching, with native `404`
  and `405` (`Allow` header).
- Lifecycle: `onRequest` / `preParsing` / `preValidation` / `preHandler` /
  `preSerialization` / `onResponse` / `onSend` / `onTimeout` hooks, `use()`
  middleware, `group()` route groups, and `register()` plugins with encapsulation
  and async `ready()`.
- Schema validation and response serialization with custom error messages.
- Cookies, `cors()`, `securityHeaders()`, JWT (`signJwt` / `verifyJwt` / `jwtAuth`),
  a pluggable logger, and per-request `req.id` / `req.log` / `req.ip`.
- Body parsing: `req.json()` / `req.text()` / `req.form` (urlencoded and
  `multipart/form-data`), plus `addContentTypeParser` and `req.parseBody()`.
- Native static files (`app.static`): MIME, `ETag` / `304`, `HEAD`, traversal-safe,
  with pre-computed gzip/brotli served by `Accept-Encoding`.
- Dynamic gzip/brotli response compression on libuv's thread pool.
- Streaming responses (`reply.stream`) over `Transfer-Encoding: chunked`, with
  native backpressure.
- A native per-IP rate limiter that answers `429` before a request reaches JS.
- `app.inject()` for in-process testing without binding a public port.
- Configurable limits and timeouts, a slowloris guard, graceful shutdown, and
  `reusePort` for multi-worker scaling.
- Unix-domain socket binding (`unixPath`) for same-host reverse-proxy setups.

### Performance

- ~99k req/s on the plaintext benchmark at ~49 MB RSS on a single thread.
