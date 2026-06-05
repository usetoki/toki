import type { DocPage } from "../../types";

export const serverOptionsPage: DocPage = {
  slug: "server-options",
  title: "Server options",
  description: "Every option you can pass to listen().",
  blocks: [
    {
      kind: "paragraph",
      text: "`app.listen(port, options)` accepts the tunables below. Every native limit is configurable here — there are no hidden magic numbers.",
    },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        ["`host`", "`0.0.0.0`", "Bind interface. Pass `0` as the port to pick a free one."],
        ["`maxBodyBytes`", "1 MiB", "Largest accepted request body (`413` above it)."],
        ["`maxHeaders`", "`128`", "Max header lines per request."],
        ["`backlog`", "`512`", "Listen backlog."],
        [
          "`headerTimeoutMs`",
          "`0`",
          "Close a connection stalled mid-request, in ms; `0` disables (slowloris guard).",
        ],
        [
          "`reusePort`",
          "`false`",
          "`SO_REUSEPORT` for kernel-balanced multi-worker scaling (Linux/BSD).",
        ],
        [
          "`rateLimit`",
          "—",
          "`{ max, windowMs }` — native per-IP limiter; see [Rate limiting](/docs/rate-limiting).",
        ],
        ["`unixPath`", "—", "Bind a unix-domain socket here instead of TCP (the port is ignored)."],
        [
          "`tls`",
          "—",
          "`{ cert, key }` PEM — terminate HTTPS directly; see [HTTPS / TLS](/docs/https).",
        ],
        ["`maxWsMessageBytes`", "16 MiB", "Largest accepted WebSocket message (`1009` above it)."],
        ["`wsCompression`", "`false`", "Offer `permessage-deflate` when a client requests it."],
      ],
    },
    { kind: "heading", id: "createapp", text: "createApp options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        ["`logger`", "—", '`"debug" | "info" | "warn" | "error" | false` or a custom `Logger`.'],
        [
          "`requestTimeoutMs`",
          "`0`",
          "Reply `408` if an async handler hasn't settled in time; `0` disables.",
        ],
      ],
    },
    { kind: "heading", id: "unix", text: "Unix-domain sockets" },
    {
      kind: "paragraph",
      text: "Bind a unix socket for a same-host reverse proxy. `req.ip` is an empty string for unix connections (there is no peer address).",
    },
    {
      kind: "code",
      snippet: {
        filename: "unix.ts",
        language: "ts",
        code: `app.listen(0, { unixPath: "/tmp/toki.sock" });`,
      },
    },
  ],
};
