# Changelog

Follows [Keep a Changelog](https://keepachangelog.com/) and [SemVer](https://semver.org/).

## [0.9.1] - 2026-06-12

### Security

- Mutual-TLS chain validation now requires a certificate presented as a chain issuer to be a CA
  (`basicConstraints cA=TRUE`, RFC 5280 §6.1.4). Previously a holder of any CA-signed leaf could
  present `[forged-leaf, their-own-leaf]` and have their own non-CA leaf accepted as the issuer of
  a forged identity — a client-identity spoof under mTLS.
- `socket.exportKeyingMaterial` rejects an empty or over-249-byte label (it would overflow the
  single-byte HkdfLabel length prefix — a reachable abort in a safety build, a wrong/non-interoperable
  export in release).
- A v4-mapped IPv6 peer (`::ffff:a.b.c.d`) shares one per-IP rate-limit bucket with its native IPv4
  form, so a dual-stack listener can't be evaded by switching address form.

### Fixed

- A raw TLS server with no `tls.alpn` now sends no ALPN extension, instead of defaulting to
  `http/1.1` (RFC 7301) — correct for a non-HTTP port.
- An SNI virtual-host certificate whose key algorithm differs from the default is rejected at
  registration rather than failing every handshake (the signature scheme is fixed before SNI).
- `socket.upgradeTLS()` throws synchronously when misused (called twice, or on an already-TLS
  socket) instead of returning a rejected promise.
- `server.setTls()` (certificate hot-reload) no longer reverts a STARTTLS server to
  terminate-at-accept — `startTls` is preserved across the swap.

### Added

- `keepAlive` / `keepAliveDelaySecs` on `connectTcp` (previously server-only), for long-lived
  outbound links.
- The TCP reference documentation now covers the full TLS peer surface (connectTcp, STARTTLS, SNI,
  ALPN, peer certificate, channel binding, several listeners, lifecycle), and the peer example adds
  SNI, backpressure, certificate hot-reload, and graceful-shutdown demonstrations.

## [0.9.0] - 2026-06-12

The raw TCP/TLS layer becomes a full TLS **peer** engine, not just a server-accept
engine — the foundation for protocols like XMPP that dial out, upgrade in place, and
bind several ports.

### Added

- **`connectTcp(host, port, options)`** — outbound TCP, plaintext or TLS. Resolves a
  `TcpSocket` post-connect (or post-handshake for TLS); rejects with a typed
  `TcpConnectError` (`reason`: `dns` / `refused` / `timeout` / `tls` / …). Verifies the
  server certificate against `servername`, supports a client certificate (`cert`/`key`)
  for mutual TLS, and shares the full `TcpSocket` surface.
- **STARTTLS** — `socket.upgradeTLS(options?)` upgrades a plaintext connection to TLS in
  place (server-configured cert, or client options). A synchronous `secure` event fires
  the moment the handshake establishes, before any post-upgrade `data`. Misuse (a second
  upgrade, or upgrading an already-TLS socket) throws synchronously.
- **TLS identity & channel binding** — `socket.peerCertificate()` (peer leaf in DER) and
  `socket.exportKeyingMaterial(length, label, context?)` (RFC 8446 §7.5 exporter / RFC 9266
  `tls-exporter` channel binding), both ends deriving identical material.
- **Virtual hosts** — `tls.sni` presents a different certificate per requested host
  (exact or `*.` wildcard, exact wins), surfaced as `socket.servername`; `tls.alpn` offers
  ALPN protocols, negotiated one on `socket.alpnProtocol`. A raw TLS server with no `alpn`
  sends no ALPN extension (RFC 7301), rather than defaulting to `http/1.1`.
- **Multiple listeners** — one `createTcpServer` can `listen()` on several ports with a
  single handler, routed by `socket.localPort` (e.g. XMPP c2s + s2s in one process).
- **Lifecycle & ops** — `socket.pause()` / `resume()` read flow control, `server.setTls()`
  certificate hot-reload, `server.stopAccepting()`, `maxConnections`, `keepAlive`,
  `idleTimeoutMs` / `handshakeTimeoutMs` (a 1s sweep reaps stalled handshakes and idle
  connections), `socket.bufferedAmount`, `socket.closeReason` / a `close` reason argument
  (`normal` / `peer-reset` / `write-queue-overflow` / `tls-error` / `handshake-timeout`),
  and an `ipv6Only` bind flag.

### Security

- mTLS chain validation now requires a certificate presented as a chain issuer to be a CA
  (`basicConstraints cA=TRUE`, RFC 5280 §6.1.4) — a holder of a CA-signed leaf can no
  longer forge an identity by presenting it as its own issuer.
- `exportKeyingMaterial` rejects a label over 249 bytes (it would overflow the HkdfLabel
  length prefix), and a v4-mapped IPv6 peer shares one per-IP rate-limit bucket with its
  native IPv4 form.

### Notes

- There is no TLS session resumption: the server completes a full handshake per connection
  and issues no session tickets.
- The engine is process-global — one `createTcpServer` (and one UDP server) per process;
  its several listeners share one options set and TLS configuration.

## [0.2.0] - 2026-06-05

### Added

- Native HTTP/1.1 engine written in Zig, running single-threaded on Node's own
  libuv loop. Parsing, routing, and I/O stay in native code, handlers stay in JS,
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
- `HEAD` requests are auto-served from the matching `GET` route (headers + the
  computed `Content-Length`, body dropped on the wire).
- Requests with a `Transfer-Encoding` header are rejected with `400`. The engine
  frames bodies by `Content-Length` only, so accepting chunked would risk a TE-vs-CL
  request-smuggling desync.
- Unix-domain socket binding (`unixPath`) for same-host reverse-proxy setups.
- WebSockets (`app.ws`): full RFC 6455 in native code — handshake, framing, masking,
  fragmentation, ping/pong, close codes + reason, subprotocol negotiation, UTF-8 and
  frame validation, a configurable message-size guard, and `message` / `close` / `ping`
  / `pong` / `drain` events. Optional `permessage-deflate` compression (RFC 7692) via
  `wsCompression`.

### Performance

- ~99k req/s on the plaintext benchmark at ~49 MB RSS on a single thread.
