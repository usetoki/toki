import type { DocPage } from "../../types";

export const tcpPage: DocPage = {
  slug: "tcp",
  title: "TCP server",
  description:
    "Raw TCP sockets backed by native libuv — accept connections, read and write bytes, with real backpressure.",
  blocks: [
    {
      kind: "paragraph",
      text: "`createTcpServer(handler, options)` opens a raw TCP listener. The accept loop and socket I/O run in native code; your handler runs once per accepted connection and works in plain bytes. Reach for this when you need a wire protocol of your own (a line protocol, a binary RPC, a proxy, a database driver) rather than HTTP.",
    },
    {
      kind: "code",
      snippet: {
        filename: "echo.ts",
        language: "ts",
        code: `import { createTcpServer } from "@usetoki/toki";

const server = createTcpServer((socket) => {
  console.log("connection from", socket.remoteAddress, socket.remotePort);
  socket.on("data", (chunk) => socket.write(chunk)); // echo back
  socket.on("close", () => console.log("gone"));
});

const { port } = server.listen(0, "127.0.0.1"); // 0 => OS-assigned port
console.log("listening on", port);`,
      },
    },
    {
      kind: "paragraph",
      text: "`listen(port, host?)` binds and starts accepting. Pass `0` to let the OS pick a free port; the chosen one comes back in the return value. `host` defaults to `0.0.0.0`.",
    },
    { kind: "heading", id: "socket", text: "The socket" },
    {
      kind: "paragraph",
      text: "Each connection is a `TcpSocket`. It carries the peer's address plus a small set of methods and events. No streams API to learn.",
    },
    {
      kind: "table",
      headers: ["Member", "Description"],
      rows: [
        ["`socket.remoteAddress`", "Peer IP as a string."],
        ["`socket.remotePort`", "Peer port as a number."],
        [
          "`socket.write(data)`",
          "Send bytes (`Uint8Array`) or a UTF-8 `string`. Returns `false` when the send buffer is backed up.",
        ],
        [
          "`socket.end(data?)`",
          "Optionally send a last chunk, flush queued writes, then half-close (FIN).",
        ],
        ["`socket.destroy()`", "Drop the connection now, discarding anything still queued."],
        [
          "`socket.pause()` / `socket.resume()`",
          "Stop and restart reading (backpressure toward the peer); queued writes still flush.",
        ],
        ["`socket.localPort`", "The local port this connection landed on — route by it across several listeners."],
        ["`socket.bufferedAmount`", "Bytes queued for sending but not yet handed to the OS."],
        [
          "`socket.on(event, fn)`",
          "Subscribe to `data`, `drain`, `end`, `close`, or `secure`. `off` removes a listener.",
        ],
      ],
    },
    {
      kind: "paragraph",
      text: "On a TLS connection the socket also carries `socket.authorized` (the mutual-TLS verdict), `socket.alpnProtocol` and `socket.servername` (the negotiated ALPN and the requested SNI host), `socket.peerCertificate()` (the peer's leaf in DER), `socket.exportKeyingMaterial(length, label, context?)` (RFC 8446 channel binding), and `socket.upgradeTLS(options?)` (STARTTLS). Those are covered under [TLS](#tls) below.",
    },
    {
      kind: "table",
      headers: ["Event", "Arguments"],
      rows: [
        ["`data`", "`(chunk: Buffer)` — a copy of received bytes, safe to retain."],
        ["`drain`", "`()` — the send buffer emptied after a backpressured `write`."],
        ["`end`", "`()` — the peer half-closed (FIN); your write side is still open."],
        ["`secure`", "`()` — a STARTTLS `upgradeTLS` handshake established (fires before any post-upgrade `data`)."],
        ["`close`", "`(reason: CloseReason)` — the connection ended; the reason says why."],
      ],
    },
    {
      kind: "paragraph",
      text: "`CloseReason` is `\"normal\"` for a clean close on either side, or one of `\"peer-reset\"` (the peer reset or truncated the connection), `\"write-queue-overflow\"` (the send backlog blew `maxWriteQueue` and the connection was dropped), `\"tls-error\"` (a TLS fault), or `\"handshake-timeout\"`. The same value is on `socket.closeReason`.",
    },
    { kind: "heading", id: "lines", text: "A line-based protocol" },
    {
      kind: "paragraph",
      text: "TCP is a stream, not a sequence of messages — one `data` event may hold part of a line, several lines, or a line split across two events. Buffer until you see a delimiter, then process whole frames.",
    },
    {
      kind: "code",
      snippet: {
        filename: "lines.ts",
        language: "ts",
        code: `createTcpServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      socket.write(\`you said: \${line}\\n\`);
    }
  });
}).listen(7000, "127.0.0.1");`,
      },
    },
    { kind: "heading", id: "backpressure", text: "Backpressure" },
    {
      kind: "paragraph",
      text: "`write` returns `false` when the kernel send buffer is full. The bytes are still queued, but stop producing until the socket drains — ignore this and a slow reader grows your queue without bound. When the queue empties, `drain` fires; resume there.",
    },
    {
      kind: "code",
      snippet: {
        filename: "stream-file.ts",
        language: "ts",
        code: `import { createReadStream } from "node:fs";

createTcpServer((socket) => {
  const file = createReadStream("/big.bin");

  file.on("data", (chunk) => {
    if (!socket.write(chunk)) file.pause(); // backed up — wait
  });
  socket.on("drain", () => file.resume()); // cleared — keep going
  file.on("end", () => socket.end());
}).listen(7001, "127.0.0.1");`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "The contract: when `write` returns `false`, pause your source; when `drain` fires, resume it. Follow it and memory stays flat no matter how slow the peer is.",
    },
    { kind: "heading", id: "closing", text: "end() vs destroy()" },
    {
      kind: "paragraph",
      text: "`end()` is the graceful path: it flushes everything you've queued, then sends a FIN to half-close your side while you can still receive the peer's reply. On a TLS connection it sends a `close_notify` alert first, queued behind your backlog — so the peer gets every byte, then a clean TLS close, then the FIN, never a truncating reset. `destroy()` is the abrupt path: it drops the connection immediately (RST) and discards queued bytes. Use it for a misbehaving client or a hard timeout. After the socket is gone, `write()` returns `false` rather than silently dropping the bytes.",
    },
    {
      kind: "code",
      snippet: {
        filename: "close.ts",
        language: "ts",
        code: `createTcpServer((socket) => {
  socket.write("welcome\\n");

  // graceful: deliver the reply, then close cleanly
  socket.end("bye\\n");

  // abrupt: cut a connection that's been idle too long
  const timer = setTimeout(() => socket.destroy(), 30_000);
  socket.on("close", () => clearTimeout(timer));
}).listen(7002, "127.0.0.1");`,
      },
    },
    { kind: "heading", id: "peer", text: "Reading the peer" },
    {
      kind: "paragraph",
      text: "`remoteAddress` and `remotePort` are set the moment the handler runs — handy for per-IP logging, allow-lists, or rejecting a connection outright.",
    },
    {
      kind: "code",
      snippet: {
        filename: "allowlist.ts",
        language: "ts",
        code: `const allowed = new Set(["127.0.0.1", "10.0.0.5"]);

createTcpServer((socket) => {
  if (!allowed.has(socket.remoteAddress)) {
    socket.destroy(); // not on the list — hang up
    return;
  }
  socket.write("ok\\n");
}).listen(7003);`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Description"],
      rows: [
        [
          "`reusePort`",
          "`boolean`",
          "`false`",
          "Set `SO_REUSEPORT` so several worker processes can share one port (Linux/BSD).",
        ],
        [
          "`noDelay`",
          "`boolean`",
          "`false`",
          "Disable Nagle's algorithm — send small writes immediately for lower latency.",
        ],
        ["`backlog`", "`number`", "`512`", "Size of the kernel's pending-connection queue."],
        [
          "`maxWriteQueue`",
          "`number`",
          "`16 MiB`",
          "Per-connection unflushed-write ceiling; a peer that stops reading is reset past it instead of buffered without bound.",
        ],
        [
          "`maxConnections`",
          "`number`",
          "`0`",
          "Cap on concurrent connections (counting pre-handshake ones); a new accept past it is reset. `0` is unlimited.",
        ],
        [
          "`keepAlive` / `keepAliveDelaySecs`",
          "`boolean` / `number`",
          "off",
          "`SO_KEEPALIVE` on accepted sockets, with the idle seconds before the first probe.",
        ],
        [
          "`idleTimeoutMs`",
          "`number`",
          "`0`",
          "Close a connection idle (no read or write) for this long; a ~1s sweep enforces it. `0` is off.",
        ],
        [
          "`handshakeTimeoutMs`",
          "`number`",
          "`0`",
          "Close a TLS connection whose handshake hasn't established in time (reason `handshake-timeout`). `0` is off.",
        ],
        [
          "`ipv6Only`",
          "`boolean`",
          "`false`",
          "Bind IPv6-only on an IPv6 host — no dual-stack v4-mapped accepts.",
        ],
        [
          "`allowHalfOpen`",
          "`boolean`",
          "`false`",
          "Keep the write side open after the peer's FIN; default ends it once the backlog flushes.",
        ],
        [
          "`rateLimit`",
          "`{ max, windowMs }`",
          "off",
          "Native per-IP accept limit — see [Rate limiting accepts](#rate-limit).",
        ],
        [
          "`engine`",
          '`"libuv" | "io_uring"`',
          '`"libuv"`',
          "I/O backend — see [The io_uring engine](#io-uring).",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "The engine is process-global: one `createTcpServer` owns it, so a *second* `createTcpServer` whose `listen()` runs throws. That one server can `listen()` on several ports, though — see [Several listeners](#listeners). To use every core, run a process per core with `reusePort: true` and let the kernel balance accepts.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "The `Buffer` handed to `data` is a copy of the received bytes — it stays valid after the handler returns, so you can buffer or queue it freely. (This differs from the WebSocket `message` buffer, which is a transient view.)",
    },
    { kind: "heading", id: "io-uring", text: "The io_uring engine" },
    {
      kind: "paragraph",
      text: 'By default the raw TCP server runs on libuv, like the rest of toki. On Linux you can opt a server onto `engine: "io_uring"` instead: accept, receive, and send all go through a Linux io_uring ring that toki drives on Node\'s own event loop (watched with one `uv_poll` on the ring fd), so handlers are still called synchronously with no thread hop. Reads come from a shared, fixed-size pool of kernel-filled buffers, so read memory tracks the pool rather than the connection count, and the per-event syscall overhead is lower than the readiness-then-read model.',
    },
    {
      kind: "code",
      snippet: {
        filename: "io-uring.ts",
        language: "ts",
        code: `const server = createTcpServer(handler, {
  engine: "io_uring", // Linux only; falls back to libuv elsewhere
  maxWriteQueue: 8 * 1024 * 1024,
});
server.listen(9000);`,
      },
    },
    {
      kind: "paragraph",
      text: "The backend is interchangeable: the socket API, events, backpressure, half-close, and TLS-engine fallback are identical to the libuv path, so the only change is the one option.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "io_uring is used only where it actually works — Linux, a recent kernel, and the io_uring syscalls permitted by the sandbox. On macOS or Windows, an old kernel, or inside a container whose seccomp profile blocks io_uring (the common default), toki prints a one-line notice and runs the server on libuv instead, so the same code is safe to ship everywhere.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: 'TLS is not terminated on the io_uring engine yet: a server that sets both `engine: "io_uring"` and `tls` runs on libuv (with a notice). Run io_uring plaintext behind a TLS-terminating proxy, or use the libuv engine for in-process TLS.',
    },
    {
      kind: "callout",
      tone: "tip",
      text: "To use io_uring in Docker, allow its syscalls — e.g. `docker run --security-opt seccomp=unconfined …`, or a custom seccomp profile that permits `io_uring_setup`, `io_uring_enter`, and `io_uring_register`. Without that the server still runs, just on libuv.",
    },
    { kind: "heading", id: "rate-limit", text: "Rate limiting accepts" },
    {
      kind: "paragraph",
      text: "`rateLimit: { max, windowMs }` caps how many connections one IP may open per window, enforced inside the engine at accept time. An over-limit peer is reset immediately: on a TLS listener that happens *before* the handshake state even exists, so a connection flood costs the attacker a SYN and costs you a hash lookup — not an ECDHE key exchange. The rejected connection never reaches JS at all.",
    },
    {
      kind: "code",
      snippet: {
        filename: "guarded.ts",
        language: "ts",
        code: `const server = createTcpServer(handler, {
  rateLimit: { max: 100, windowMs: 60_000 }, // 100 accepts per IP per minute
  tls: { cert, key }, // over-limit peers are reset before the handshake
});`,
      },
    },
    {
      kind: "paragraph",
      text: "The counter is a fixed window per source address (IPv4 or IPv6), swept as it goes, with a hard cap on tracked addresses so the table itself can't be ballooned. When the option is absent the accept path pays a single branch.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "This guard counts *accepts*. For per-key budgets (a user id, an API key), custom over-limit responses, or counters shared across processes via Redis, wrap your handler with `tcpRateLimit` from [`@usetoki/toki-ratelimiter`](/docs/plugin-rate-limiter) — the two compose: the native guard absorbs floods, the plugin enforces application policy.",
    },
    { kind: "heading", id: "tls", text: "TLS" },
    {
      kind: "paragraph",
      text: "Pass `tls: { cert, key }` and the listener terminates real TLS 1.3 on the raw socket — the same native engine that powers HTTPS, just on your own protocol. There is no reverse proxy in front: the handshake (ECDHE key exchange, an AEAD cipher) runs in Zig. Your handler is called only once the handshake completes, so the connection is already an established session by your first `write`. You always work in plaintext: the bytes you read are decrypted, the bytes you write are encrypted on the wire.",
    },
    {
      kind: "code",
      snippet: {
        filename: "echo-tls.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";
import { createTcpServer } from "@usetoki/toki";

const server = createTcpServer((socket) => {
  // the handshake is already done — this is plaintext over an encrypted session
  socket.on("data", (chunk) => socket.write(chunk)); // echo
}, {
  tls: {
    cert: readFileSync("cert.pem"), // PEM chain, leaf first, then any intermediates
    key: readFileSync("key.pem"),   // RSA or EC private key
  },
});

const { port } = server.listen(0, "127.0.0.1");
console.log("tls echo on", port);`,
      },
    },
    {
      kind: "paragraph",
      text: "`cert` and `key` accept a PEM string or raw bytes (`Buffer`/`Uint8Array`). The cert is a chain with the leaf first; the key may be RSA or EC. A client connects with `node:tls` exactly as it would to any TLS server:",
    },
    {
      kind: "code",
      snippet: {
        filename: "client.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";
import { connect } from "node:tls";

// trust the server's cert (here a self-signed dev pair) as the CA — never
// disable verification with rejectUnauthorized: false.
const socket = connect(port, "127.0.0.1", { ca: readFileSync("cert.pem") }, () => {
  socket.write("hello over tls\\n");
});
socket.on("data", (chunk) => {
  console.log("echoed:", chunk.toString()); // "hello over tls"
  socket.end();
});`,
      },
    },
    {
      kind: "heading",
      id: "tls-options",
      text: "The tls option",
    },
    {
      kind: "paragraph",
      text: "`cert` and `key` are all you need for ordinary server-authenticated TLS. The other three fields turn on mutual TLS (client-certificate auth).",
    },
    {
      kind: "table",
      headers: ["Field", "Type", "Default", "Description"],
      rows: [
        ["`cert`", "`string | Uint8Array`", "—", "PEM certificate chain, leaf first. Required."],
        [
          "`key`",
          "`string | Uint8Array`",
          "—",
          "PEM private key for the leaf cert — RSA or EC. Required.",
        ],
        [
          "`requestCert`",
          "`boolean`",
          "`false`",
          "Ask the client for a certificate during the handshake (turns on mTLS). Requires `ca`.",
        ],
        [
          "`ca`",
          "`string | Uint8Array`",
          "—",
          "PEM CA bundle the client certificate is verified against. Mandatory once `requestCert` is set.",
        ],
        [
          "`rejectUnauthorized`",
          "`boolean`",
          "`false`",
          "With `requestCert`, fail the handshake when the client cert is missing or untrusted. Off: allow the connection and report the result on `socket.authorized`.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "This is TLS termination directly on the raw socket — no reverse proxy in front. It negotiates TLS 1.3 only, AEAD suites only, with ECDHE for forward secrecy; the server key may be RSA or EC.",
    },
    { kind: "heading", id: "mtls", text: "Mutual TLS (client certificates)" },
    {
      kind: "paragraph",
      text: "Set `requestCert: true` and a `ca` bundle, and the server asks each client for a certificate and verifies it against `ca`. Add `rejectUnauthorized: true` and a client that presents no cert — or one not signed by your CA — fails the handshake and never reaches your handler. Leave it off and the connection is allowed either way; `socket.authorized` tells you whether a valid client cert was presented.",
    },
    {
      kind: "code",
      snippet: {
        filename: "mtls-server.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";
import { createTcpServer } from "@usetoki/toki";

const server = createTcpServer((socket) => {
  // with rejectUnauthorized we only get here on a verified client cert
  console.log("client authorized:", socket.authorized); // true
  socket.write("welcome\\n");
}, {
  tls: {
    cert: readFileSync("server-cert.pem"),
    key: readFileSync("server-key.pem"),
    requestCert: true,                       // ask the client for a cert
    ca: readFileSync("client-ca.pem"),       // verify it against this CA
    rejectUnauthorized: true,                // reject anyone unverified
  },
});

server.listen(8443, "127.0.0.1");`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`requestCert` without `ca` throws: there is nothing to verify the client cert against. Always pass the CA bundle that signs your client certs.",
    },
    {
      kind: "paragraph",
      text: "The client side presents its certificate with `node:tls` by passing `cert` and `key` to `connect`:",
    },
    {
      kind: "code",
      snippet: {
        filename: "mtls-client.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";
import { connect } from "node:tls";

const socket = connect(8443, "127.0.0.1", {
  ca: readFileSync("server-cert.pem"),  // trust the server
  cert: readFileSync("client-cert.pem"), // present our own cert
  key: readFileSync("client-key.pem"),
}, () => {
  console.log("authorized by server:", socket.authorized);
  socket.write("hi\\n");
});
socket.on("data", (chunk) => {
  console.log(chunk.toString()); // "welcome"
  socket.end();
});`,
      },
    },
    {
      kind: "paragraph",
      text: "Without `rejectUnauthorized`, the handshake always succeeds and you decide what to do with an unauthenticated peer. `socket.authorized` is `true` only when a client cert verified against your `ca` — gate sensitive work on it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "mtls-soft.ts",
        language: "ts",
        code: `createTcpServer((socket) => {
  if (!socket.authorized) {
    socket.end("anonymous access denied\\n"); // no valid client cert
    return;
  }
  socket.write("ok\\n");
}, {
  tls: {
    cert: readFileSync("server-cert.pem"),
    key: readFileSync("server-key.pem"),
    requestCert: true,
    ca: readFileSync("client-ca.pem"),
    // rejectUnauthorized omitted: let everyone in, then check socket.authorized
  },
}).listen(8444, "127.0.0.1");`,
      },
    },
    { kind: "heading", id: "sni", text: "Virtual hosts (SNI)" },
    {
      kind: "paragraph",
      text: "Serve a different certificate per requested host with `tls.sni`: an array of `{ servername, cert, key }`. The `servername` is an exact host or a `*.` wildcard (one label); the top-level `cert`/`key` stays the default for any name that doesn't match, and an exact entry wins over an overlapping wildcard. The requested name is on `socket.servername`. All certificates — default and vhosts — must use the same key algorithm, since the signature scheme is chosen before the SNI name is read; a mismatched vhost cert is rejected at registration.",
    },
    {
      kind: "code",
      snippet: {
        filename: "sni.ts",
        language: "ts",
        code: `createTcpServer((socket) => {
  console.log("requested host:", socket.servername); // e.g. "chat.example.com"
}, {
  tls: {
    cert: defaultCert, key: defaultKey,         // default for any unmatched name
    sni: [
      { servername: "chat.example.com", cert: chatCert, key: chatKey },
      { servername: "*.example.com", cert: wildCert, key: wildKey },
    ],
  },
}).listen(5223, "0.0.0.0");`,
      },
    },
    { kind: "heading", id: "alpn", text: "ALPN" },
    {
      kind: "paragraph",
      text: "Offer application protocols with `tls.alpn`, in preference order; the negotiated one is on `socket.alpnProtocol`. The server's order wins. With no `alpn` configured a raw TLS server sends no ALPN extension at all (it does not invent `http/1.1`), and if the client and server share no protocol the handshake fails.",
    },
    {
      kind: "code",
      snippet: {
        filename: "alpn.ts",
        language: "ts",
        code: `createTcpServer((socket) => {
  if (socket.alpnProtocol === "xmpp-client") { /* speak XMPP */ }
}, {
  tls: { cert, key, alpn: ["xmpp-client", "http/1.1"] },
}).listen(5223);`,
      },
    },
    { kind: "heading", id: "tls-identity", text: "Peer certificate & channel binding" },
    {
      kind: "paragraph",
      text: "`socket.peerCertificate()` returns the peer's leaf certificate as DER (a `Buffer`) — the client's certificate on a mutual-TLS server, the server's on a `connectTcp` client — or `undefined` on a plaintext connection. Parse the X.509 in JS (`new X509Certificate(der)`). `socket.exportKeyingMaterial(length, label, context?)` derives keying material bound to the session (RFC 8446 §7.5; the RFC 9266 `tls-exporter` channel binding for SCRAM-SHA-256-PLUS): both ends of a connection derive identical bytes for the same label.",
    },
    {
      kind: "code",
      snippet: {
        filename: "identity.ts",
        language: "ts",
        code: `import { X509Certificate } from "node:crypto";

createTcpServer((socket) => {
  const der = socket.peerCertificate();
  if (der) console.log("client CN:", new X509Certificate(der).subject);
  // channel binding both ends agree on, for SCRAM-PLUS
  const cb = socket.exportKeyingMaterial(32, "EXPORTER-Channel-Binding");
}, { tls: { cert, key, requestCert: true, ca } }).listen(5222);`,
      },
    },
    { kind: "heading", id: "starttls", text: "STARTTLS (upgrade in place)" },
    {
      kind: "paragraph",
      text: "Some protocols (XMPP, SMTP, IMAP) start in cleartext and upgrade the same connection to TLS after a negotiation. Set `startTls: true` so the server keeps its certificate ready but does not terminate TLS at accept, then call `socket.upgradeTLS()` once the peer asks. On a `connectTcp` client, pass the client options (`servername`, `ca`, `cert`, `key`, `alpn`). It resolves when the handshake establishes — but a synchronous `secure` event fires first, before any post-upgrade `data`, so flip your \"encrypted now\" state in the `secure` handler. After the upgrade the socket is indistinguishable from a direct-TLS one: `authorized`, `peerCertificate()`, `exportKeyingMaterial()`, `alpnProtocol`, backpressure.",
    },
    {
      kind: "code",
      snippet: {
        filename: "starttls.ts",
        language: "ts",
        code: `const server = createTcpServer((socket) => {
  let secure = false;
  socket.on("secure", () => (secure = true)); // fires before any encrypted data
  socket.on("data", (chunk) => {
    if (!secure && chunk.toString() === "STARTTLS") {
      socket.write("PROCEED");
      void socket.upgradeTLS();      // uses the server's configured certificate
      return;
    }
    if (secure) socket.write(chunk); // now over TLS
  });
}, { startTls: true, tls: { cert, key } });
server.listen(5222);`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Byte-ordering contract: the engine reads fresh into the TLS buffer at the upgrade, so plaintext that arrived before `upgradeTLS()` is never replayed into the TLS session (immunity to the STARTTLS-injection class, CVE-2011-0411). Discarding any leftover cleartext in your line buffer after the trigger is still your job. Upgrading twice, or upgrading an already-TLS socket, throws synchronously.",
    },
    { kind: "heading", id: "connect", text: "Outbound connections" },
    {
      kind: "paragraph",
      text: "`connectTcp(host, port, options)` dials out — plaintext, or TLS as the client. It resolves a `TcpSocket` once connected (and, with `tls`, once the handshake completes), and rejects with a `TcpConnectError` carrying a `reason` (`dns`, `refused`, `timeout`, `tls`, …) — it never leaves a half-open handle behind. The returned socket has the whole `TcpSocket` surface. Pass an already-resolved IP (do your `node:dns` SRV lookups yourself) or a hostname; with `tls`, the server certificate is verified against `servername` (defaults to `host`), and `cert`/`key` present a client certificate for mutual TLS.",
    },
    {
      kind: "code",
      snippet: {
        filename: "connect.ts",
        language: "ts",
        code: `import { connectTcp, TcpConnectError } from "@usetoki/toki";

try {
  const socket = await connectTcp("peer.example", 5269, {
    tls: { servername: "peer.example", ca, cert, key, alpn: ["xmpp-server"] },
    keepAlive: true,
    timeoutMs: 10_000,
  });
  console.log("server authorized:", socket.authorized);
  socket.write("dialback\\n");
} catch (e) {
  if (e instanceof TcpConnectError) console.error("connect failed:", e.reason);
}`,
      },
    },
    { kind: "heading", id: "listeners", text: "Several listeners" },
    {
      kind: "paragraph",
      text: "One `createTcpServer` can bind several ports — call `listen()` more than once. Every listener shares the one handler, options set, and TLS configuration; route by `socket.localPort` to tell them apart. An XMPP server runs client-to-server on 5222 and server-to-server on 5269 this way, in a single process. (The `io_uring` engine supports a single listener.)",
    },
    {
      kind: "code",
      snippet: {
        filename: "listeners.ts",
        language: "ts",
        code: `const server = createTcpServer((socket) => {
  const role = socket.localPort === c2s.port ? "c2s" : "s2s";
  socket.on("data", (chunk) => handle(role, socket, chunk));
}, { startTls: true, tls: { cert, key } });

const c2s = server.listen(5222);
const s2s = server.listen(5269);`,
      },
    },
    { kind: "heading", id: "operations", text: "Lifecycle & hot-reload" },
    {
      kind: "paragraph",
      text: "`server.stopAccepting()` closes the listeners but leaves established connections running — end them yourself (a protocol may exchange a closing tag first), then `server.close()`. `server.setTls(tls)` swaps the entire TLS configuration (cert/key, mTLS, ALPN, SNI) between handshakes without dropping live sessions — for a Let's Encrypt rotation, established connections keep their certificate and new handshakes take the new one.",
    },
    {
      kind: "code",
      snippet: {
        filename: "operations.ts",
        language: "ts",
        code: `// rotate the certificate with zero downtime
server.setTls({ cert: newCert, key: newKey });

// drain on shutdown: stop accepting, let live connections finish, then close
process.on("SIGTERM", () => {
  server.stopAccepting();
  for (const s of liveSockets) s.end("<close/>");
  setTimeout(() => server.close(), 5_000);
});`,
      },
    },
    { kind: "heading", id: "tls-perf", text: "Performance" },
    {
      kind: "paragraph",
      text: "Reads are TLS-record-batched: the engine decrypts every record available from one libuv read and hands them to your handler as a single `data` dispatch, rather than one crossing into JS per record. Throughput is around 1.4 GB/s on a release build and is cipher-bound. The AEAD cipher, not toki, is the ceiling.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Build in release for the TLS fast path. A Debug build runs the cipher far slower; the 1.4 GB/s figure is a release-mode number.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "TLS 1.3 only. A client that offers nothing newer than TLS 1.2 is rejected at the handshake — there is no 1.2 fallback. Make sure your clients speak 1.3 (every current `node:tls`, browser, and curl does).",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "No session resumption yet: no TLS tickets, no session IDs. Every connection runs a full handshake, including the asymmetric key exchange. Fine for long-lived connections; for very short, very frequent ones the per-connection handshake cost is the thing to watch.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "Need HTTP over TLS rather than a raw protocol? The HTTPS page covers `app.listen({ tls })`, which runs the same TLS 1.3 engine for the HTTP server. mTLS, though, lives only here on the raw TCP server.",
    },
    { kind: "heading", id: "shutdown", text: "Shutting down" },
    {
      kind: "paragraph",
      text: "`server.close()` stops accepting new connections and closes every live one. Call it on shutdown so the process can exit cleanly.",
    },
    {
      kind: "code",
      snippet: {
        filename: "shutdown.ts",
        language: "ts",
        code: `const server = createTcpServer((socket) => socket.write("hi\\n"));
server.listen(7004, "127.0.0.1");

process.on("SIGTERM", () => server.close());`,
      },
    },
  ],
};
