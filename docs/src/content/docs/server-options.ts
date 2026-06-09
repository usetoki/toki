import type { DocPage } from "../../types";

export const serverOptionsPage: DocPage = {
  slug: "server-options",
  title: "Server options",
  description: "Every option you can pass to listen() and createApp().",
  blocks: [
    {
      kind: "paragraph",
      text: "Server tunables are split in two. `createApp(options)` sets per-app behavior that lives for the process: the logger and the request timeout. `app.listen(port, options)` sets per-socket behavior — bind address, limits, timeouts, TLS. Every native limit is configurable here; there are no hidden magic numbers.",
    },
    { kind: "heading", id: "listen", text: "listen(port, options)" },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        [
          "`host`",
          "`\"0.0.0.0\"`",
          "Bind interface. Use `\"127.0.0.1\"` to stay local. Pass `0` as the port to let the OS pick a free one (read it back from `handle.port`).",
        ],
        [
          "`maxBodyBytes`",
          "1 MiB",
          "Largest accepted request body. A larger body gets a native `413` before reaching JS.",
        ],
        ["`maxHeaders`", "`128`", "Max header lines per request; over this the request is rejected."],
        [
          "`headerTimeoutMs`",
          "`0`",
          "Close a connection that has sent no data within this many ms — the slowloris guard. `0` disables it.",
        ],
        ["`backlog`", "`512`", "Pending-connection (accept) queue depth passed to `listen(2)`."],
        [
          "`reusePort`",
          "`false`",
          "Set `SO_REUSEPORT` so several processes can bind the same port and the kernel load-balances across them (Linux/BSD).",
        ],
        [
          "`rateLimit`",
          "—",
          "`{ max, windowMs }` — the native per-IP limiter; over-limit gets a native `429`. See [Rate limiting](/docs/rate-limiting).",
        ],
        [
          "`unixPath`",
          "—",
          "Bind a unix-domain socket at this path instead of TCP (the `port` argument is ignored).",
        ],
        [
          "`tls`",
          "—",
          "`{ cert, key }` PEM (text or bytes) — terminate HTTPS in-process, TLS 1.3 only. See [HTTPS / TLS](/docs/https).",
        ],
        [
          "`maxWsMessageBytes`",
          "16 MiB",
          "Largest accepted WebSocket message; a larger one closes the socket with `1009`.",
        ],
        [
          "`wsCompression`",
          "`false`",
          "Offer `permessage-deflate` (RFC 7692) when a client requests it.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Sizes are bytes. `1 MiB` = `1 << 20` = `1_048_576`. Write them with numeric separators (`5 << 20` for 5 MiB) so the intent is obvious.",
    },
    { kind: "heading", id: "createapp", text: "createApp(options)" },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        [
          "`logger`",
          "off",
          "A `Logger`, a level string (`\"debug\" | \"info\" | \"warn\" | \"error\"`) for the built-in console logger, or `false`/omitted for silence.",
        ],
        [
          "`requestTimeoutMs`",
          "`0`",
          "Reply `408` if an async handler hasn't settled within this many ms (runs `onTimeout` hooks first). `0` disables it.",
        ],
      ],
    },
    { kind: "heading", id: "tuned", text: "A tuned listen()" },
    {
      kind: "paragraph",
      text: "A realistic production setup behind a reverse proxy: bind locally, cap bodies, guard against slowloris, and time out runaway handlers.",
    },
    {
      kind: "code",
      snippet: {
        filename: "server.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";

const app = createApp({
  logger: "info",
  requestTimeoutMs: 10_000, // 408 a handler that hangs past 10s
});

// ... register routes ...

const handle = app.listen(3000, {
  host: "127.0.0.1",          // only the local proxy reaches us
  maxBodyBytes: 5 << 20,      // 5 MiB uploads
  headerTimeoutMs: 5_000,     // drop a stalled connection after 5s
  backlog: 1024,
  rateLimit: { max: 200, windowMs: 60_000 },
});

console.log(\`listening on \${handle.port}\`);
process.on("SIGTERM", () => handle.close());`,
      },
    },
    { kind: "heading", id: "reuseport", text: "Scaling across processes with reusePort" },
    {
      kind: "paragraph",
      text: "`reusePort` lets every worker in a cluster bind the same port; the kernel spreads incoming connections across them. Each worker is its own process with its own engine. There is no shared memory, so anything stateful (a rate-limit `Map`, an in-process cache) is per-worker.",
    },
    {
      kind: "code",
      snippet: {
        filename: "cluster.ts",
        language: "ts",
        code: `import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { createApp } from "@usetoki/toki";

if (cluster.isPrimary) {
  for (let i = 0; i < availableParallelism(); i++) cluster.fork();
} else {
  const app = createApp();
  app.get("/", () => "ok");
  app.listen(3000, { reusePort: true }); // every worker binds :3000
}`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`reusePort` is Linux/BSD only. On other platforms a second bind to the same port fails. Keep one `listen` per process: Toki's engine is process-global, so a second `listen()` in the same process clobbers the first.",
    },
    { kind: "heading", id: "unix", text: "Unix-domain sockets" },
    {
      kind: "paragraph",
      text: "Bind a unix socket for a same-host reverse proxy: no TCP port, no loopback round-trip. The `port` argument is ignored. `req.ip` is an empty string for unix connections (there is no peer address), which also means the native per-IP rate limiter can't key on the caller.",
    },
    {
      kind: "code",
      snippet: {
        filename: "unix.ts",
        language: "ts",
        code: `app.listen(0, { unixPath: "/tmp/toki.sock" });`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Pass `0` as the port whenever the address is decided elsewhere: `unixPath`, an ephemeral test port, or a `reusePort` worker. Read the actual bound TCP port back from the returned handle's `.port`.",
    },
  ],
};
