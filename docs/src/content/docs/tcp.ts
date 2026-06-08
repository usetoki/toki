import type { DocPage } from "../../types";

export const tcpPage: DocPage = {
  slug: "tcp",
  title: "TCP server",
  description: "Raw TCP sockets backed by native libuv — accept connections, read and write bytes, with real backpressure.",
  blocks: [
    {
      kind: "paragraph",
      text: "`createTcpServer(handler, options)` opens a raw TCP listener. The accept loop and socket I/O run in native code; your handler runs once per accepted connection and works in plain bytes. Reach for this when you need a wire protocol of your own — a line protocol, a binary RPC, a proxy, a database driver — rather than HTTP.",
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
      text: "`listen(port, host?)` binds and starts accepting. Pass `0` to let the OS pick a free port — the chosen one comes back in the return value. `host` defaults to `0.0.0.0`.",
    },
    { kind: "heading", id: "socket", text: "The socket" },
    {
      kind: "paragraph",
      text: "Each connection is a `TcpSocket`. It carries the peer's address and a small set of methods and events — no streams API to learn.",
    },
    {
      kind: "table",
      headers: ["Member", "Description"],
      rows: [
        ["`socket.remoteAddress`", "Peer IP as a string."],
        ["`socket.remotePort`", "Peer port as a number."],
        ["`socket.write(data)`", "Send bytes (`Uint8Array`) or a UTF-8 `string`. Returns `false` when the send buffer is backed up."],
        ["`socket.end(data?)`", "Optionally send a last chunk, flush queued writes, then half-close (FIN)."],
        ["`socket.destroy()`", "Drop the connection now, discarding anything still queued."],
        ["`socket.on(event, fn)`", "Subscribe to `data`, `drain`, or `close`. `off` removes a listener."],
      ],
    },
    {
      kind: "table",
      headers: ["Event", "Arguments"],
      rows: [
        ["`data`", "`(chunk: Buffer)` — a copy of received bytes, safe to retain."],
        ["`drain`", "`()` — the send buffer emptied after a backpressured `write`."],
        ["`close`", "`()` — the connection ended."],
      ],
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
      text: "`write` returns `false` when the kernel send buffer is full — the bytes are queued, but you should stop producing until the socket drains. Ignoring this lets a slow reader grow your queue without bound. When the queue empties, `drain` fires; resume there.",
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
      text: "The contract is simple: when `write` returns `false`, pause your source; when `drain` fires, resume it. Following it keeps memory flat no matter how slow the peer is.",
    },
    { kind: "heading", id: "closing", text: "end() vs destroy()" },
    {
      kind: "paragraph",
      text: "`end()` is the graceful path: it flushes everything you've queued, then sends a FIN to half-close your side while you can still receive the peer's reply. `destroy()` is the abrupt path: it drops the connection immediately and discards queued bytes — use it for a misbehaving client or a hard timeout.",
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
        ["`reusePort`", "`boolean`", "`false`", "Set `SO_REUSEPORT` so several worker processes can share one port (Linux/BSD)."],
        ["`noDelay`", "`boolean`", "`false`", "Disable Nagle's algorithm — send small writes immediately for lower latency."],
        ["`backlog`", "`number`", "`512`", "Size of the kernel's pending-connection queue."],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "One TCP server per process. The native engine is a singleton, so a second `listen()` throws. To use every core, run several processes with `reusePort: true` and let the kernel balance accepts across them.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "The `Buffer` handed to `data` is a copy of the received bytes — it stays valid after the handler returns, so you can buffer or queue it freely. (This differs from the WebSocket `message` buffer, which is a transient view.)",
    },
    { kind: "heading", id: "tls", text: "TLS" },
    {
      kind: "paragraph",
      text: "Pass `tls: { cert, key }` and the listener terminates real TLS on the raw socket — the same native engine that powers HTTPS, just on your own protocol. The handshake runs in Zig; your handler is called only once it completes, so the connection is already an established session by your first `write`. You always work in plaintext — the bytes you read are decrypted, the bytes you write are encrypted on the wire.",
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
    cert: readFileSync("cert.pem"), // leaf first, then any intermediates
    key: readFileSync("key.pem"),
  },
});

const { port } = server.listen(0, "127.0.0.1");
console.log("tls echo on", port);`,
      },
    },
    {
      kind: "paragraph",
      text: "`cert` and `key` accept a PEM string or raw bytes (`Buffer`/`Uint8Array`). A client connects with `node:tls` exactly as it would to any TLS server:",
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
      kind: "callout",
      tone: "note",
      text: "This is TLS termination directly on the raw socket — no reverse proxy in front. It negotiates TLS 1.3 and TLS 1.2 with AEAD suites only (AES-GCM, ChaCha20-Poly1305) and ECDHE for forward secrecy; the server key may be RSA or EC.",
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
