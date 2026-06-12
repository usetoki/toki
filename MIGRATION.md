# Migrating from `node:net` / `node:tls` to toki

toki's raw TCP layer is a drop-in-ish replacement for `node:net` + `node:tls` that runs the
accept, read, write, and TLS-handshake paths in the native engine on Node's own libuv loop.
This guide maps the APIs you know onto toki's and calls out the few places the model differs.

If you only serve HTTP, you don't need this — use `createApp`. This is for raw protocols
(XMPP, SMTP, a custom binary protocol) where you own the bytes on the socket.

## The shape

```ts
import { createTcpServer, connectTcp, type TcpSocket } from "@usetoki/toki";

const server = createTcpServer((socket: TcpSocket) => {
  socket.on("data", (chunk) => socket.write(chunk)); // echo
  socket.on("close", (reason) => {});
});
const { port } = server.listen(0, "127.0.0.1"); // 0 → a free port, returned
```

A handler-per-connection, like `net.createServer((socket) => …)`. The handler runs once the
connection is ready — for a TLS server, _after_ the handshake, so your first `write` is
already encrypted.

## Server: `net.createServer` → `createTcpServer`

| `node:net` / `node:tls`                   | toki                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `net.createServer(onConn)`                | `createTcpServer(onConn, options)`                                               |
| `tls.createServer({ cert, key }, onConn)` | `createTcpServer(onConn, { tls: { cert, key } })`                                |
| `server.listen(port, host)`               | `server.listen(port, host)` → `{ port }` (sync; `0` picks a port)                |
| `server.listen` on several ports          | call `server.listen()` again — one handler, route by `socket.localPort`          |
| `server.close()`                          | `server.close()` (stops accepting, drops live connections)                       |
| `{ requestCert, ca, rejectUnauthorized }` | same keys under `tls: { … }`                                                     |
| `{ ALPNProtocols }`                       | `tls: { alpn: ["h2", "http/1.1"] }`                                              |
| SNI `SNICallback`                         | `tls: { sni: [{ servername, cert, key }] }` (declarative; `*.` wildcards)        |
| `server.setSecureContext()`               | `server.setTls({ cert, key, … })` (hot-reload; live sessions keep their context) |

### Server lifecycle & limits

These have no direct `node:net` analogue — they're configured on `createTcpServer`'s
options or called on the server:

| API | What it does |
| --- | --- |
| `server.stopAccepting()` | Stop accepting new connections; existing ones keep running (then `end` them and `close()`). |
| `maxConnections` | Reset a new accept past the cap (counts pre-handshake connections). |
| `keepAlive` / `keepAliveDelaySecs` | `SO_KEEPALIVE` on accepted sockets. |
| `idleTimeoutMs` | Close a connection with no read/write activity (a ~1s sweep). |
| `handshakeTimeoutMs` | Close a TLS connection whose handshake never establishes (reason `handshake-timeout`). |
| `maxWriteQueue` | Per-connection unflushed-write ceiling; a peer past it is dropped (reason `write-queue-overflow`). |
| `rateLimit: { max, windowMs }` | Native per-IP accept guard, enforced before the handshake. |
| `ipv6Only` | Bind IPv6-only (no dual-stack v4-mapped accepts). |

## Connection: `net.Socket` / `tls.TLSSocket` → `TcpSocket`

| `node:net` socket                                 | toki `TcpSocket`                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `socket.on("data", buf => …)`                     | same (`chunk` is a `Buffer`)                                              |
| `socket.write(data)` → backpressure bool          | same — `false` means the queue is backing up; resume on `drain`           |
| `socket.on("drain", …)`                           | same                                                                      |
| `socket.end(data?)`                               | same — flushes, then half-closes (FIN); TLS sends `close_notify` first    |
| `socket.destroy()`                                | same — drops the connection now (RST)                                     |
| `socket.pause()` / `socket.resume()`              | same — stop/resume reading (backpressure)                                 |
| `socket.remoteAddress` / `socket.remotePort`      | same                                                                      |
| `socket.localPort`                                | same — the port this connection landed on (route across listeners)        |
| `socket.bufferedAmount`                           | same — unflushed send-queue bytes                                         |
| `socket.on("end", …)` / `socket.on("close", …)`   | same; `close`'s argument is a `CloseReason` string                        |
| `socket.authorized` (TLS)                         | same                                                                      |
| `socket.alpnProtocol` (TLS)                       | same                                                                      |
| `socket.servername` (TLS server)                  | same — the SNI name the client asked for                                  |
| `tlsSocket.getPeerCertificate()`                  | `socket.peerCertificate()` → leaf in **DER** (a `Buffer`), or `undefined` |
| `tlsSocket.exportKeyingMaterial(len, label, ctx)` | same signature                                                            |

## Client: `net.connect` / `tls.connect` → `connectTcp`

```ts
const sock = await connectTcp("host", 443, {
  tls: { servername: "host", ca, alpn: ["h2"] }, // omit `tls` for a plaintext client
});
```

`connectTcp` resolves a `Promise<TcpSocket>` once connected (and, with `tls`, once the
handshake completes) — no `"connect"`/`"secureConnect"` event to wait on. A failure rejects
with a `TcpConnectError` carrying a `reason` (`dns`, `refused`, `timeout`, `tls`, …).

## STARTTLS: `tls.connect({ socket })` → `socket.upgradeTLS()`

Where Node re-wraps a plaintext `net.Socket` in a new `tls.TLSSocket`, toki upgrades the
**same** socket in place:

```ts
// server, configured with `startTls: true` so connections begin in cleartext
socket.on("secure", () => {
  /* fires synchronously when the handshake establishes */
});
socket.on("data", (chunk) => {
  if (chunk.toString() === "STARTTLS") {
    socket.write("PROCEED");
    void socket.upgradeTLS(); // uses the server's configured cert
  }
});

// client
await client.upgradeTLS({ servername: "host", ca, cert, key }); // cert/key → mutual TLS
```

Listen for the synchronous `secure` event, not just the resolved promise: the promise settles
on a microtask that can trail a first post-upgrade `data` chunk, so flip your "is encrypted now"
state in the `secure` handler.

## What's different from `node:net`

- **The engine is process-global.** One `createTcpServer` owns it (a second one's `listen()`
  throws). That one server can bind many ports; route by `socket.localPort`. The same holds
  for `createUdpServer`. To scale across cores, run a process per core with `reusePort`.
- **`listen()` is synchronous** and returns `{ port }` directly — no `"listening"` event.
- **No `Duplex` stream.** `TcpSocket` is an event emitter with `write`/`end`/`pause`/`resume`,
  not a Node stream — there's no `pipe()`. Drive it with `data`/`drain`/`end`/`close`.
- **TLS is 1.3-only on the server** (AEAD suites). RSA and EC keys; `connectTcp` clients also
  speak 1.2 to external servers.
- **No TLS session resumption.** Every server handshake is full; no session tickets are issued.
- **`close`'s reason is explicit.** Instead of inferring a reset from an `error` event, read
  the `CloseReason` (`"normal"`, `"peer-reset"`, `"write-queue-overflow"`, `"tls-error"`,
  `"handshake-timeout"`) passed to the `close` listener and on `socket.closeReason`.

See `examples/tcp.ts`, `examples/tcp-tls.ts`, `examples/tcp-mtls.ts`, and
`examples/tcp-tls-peer.ts` for runnable end-to-end versions of each of these.
