import type { DocPage } from "../../types";

export const introductionPage: DocPage = {
  slug: "introduction",
  title: "Introduction",
  description: "What toki is, how it works, and the boundary between native and JavaScript code.",
  blocks: [
    {
      kind: "paragraph",
      text: "Toki is a blazing-fast HTTP framework for Node.js. It pairs a clean, fully-typed TypeScript API with a native HTTP engine written in [Zig](https://ziglang.org). Parsing, routing, static files, and compression run in native code; your handlers stay in JavaScript.",
    },
    {
      kind: "paragraph",
      text: "The engine runs on Node's own libuv loop and calls handlers synchronously on the JS thread: no worker threads, no `ThreadsafeFunction`, no cross-thread hop. On the plaintext benchmark it sustains ~99k req/s at ~49 MB RSS on a single thread. You write ordinary `async` functions; toki keeps them on a synchronous fast path until one actually returns a `Promise`.",
    },
    { kind: "heading", id: "hello-world", text: "Hello, world" },
    {
      kind: "paragraph",
      text: "A toki app is an object you register routes on, then `listen`. Handlers return a value and toki turns it into a response.",
    },
    {
      kind: "code",
      snippet: {
        filename: "server.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp();

app.get("/", () => reply.text("Hello, World!"));
app.get("/users/:id", (req) => reply.json({ id: req.params.id }));

app.listen(3000);`,
      },
    },
    {
      kind: "paragraph",
      text: "Run it with `node server.ts`. Node 22+ strips the types and runs the file directly, no build step. See [Installation](/docs/installation) for the supported versions and platforms.",
    },
    { kind: "heading", id: "feature-surface", text: "Feature surface" },
    {
      kind: "paragraph",
      text: "One package covers the whole request lifecycle and the lower transport layers it sits on:",
    },
    {
      kind: "table",
      headers: ["Area", "What you get"],
      rows: [
        [
          "HTTP routing",
          "Methods, `:params`, `*` wildcards, prefixed [groups](/docs/routing), a not-found handler.",
        ],
        [
          "Lifecycle hooks",
          "`onRequest` → `preHandler` → handler → `onResponse` → `onSend`, plus [error handling](/docs/error-handling).",
        ],
        [
          "Plugins",
          "Encapsulated [plugins](/docs/plugins) with their own scope, prefix, and hooks; sync or async.",
        ],
        [
          "Validation",
          "JSON-schema [validation](/docs/validation) of body/query/params and fast response serialization.",
        ],
        ["WebSockets", "Native framing and per-message-deflate via [`app.ws`](/docs/websockets)."],
        [
          "Static / compression / streaming",
          "[Static serving](/docs/static-files) with ETag, gzip/brotli [compression](/docs/compression), chunked [streaming](/docs/streaming) and SSE.",
        ],
        [
          "Raw transports",
          "Native [TCP](/docs/tcp) (libuv, or an optional Linux [io_uring](/docs/tcp#io-uring) engine) and [UDP](/docs/udp) servers on the same loop — pooled connections, real backpressure, half-close.",
        ],
        [
          "TLS & mTLS",
          "Native TLS 1.3 termination for [HTTPS](/docs/https) and raw [TCP](/docs/tcp), including mutual-TLS client certificates — no reverse proxy.",
        ],
        [
          "Secure UDP",
          "Per-datagram AES-256-GCM under a shared key, or a [Noise XX](/docs/udp) session with mutual auth and forward secrecy.",
        ],
      ],
    },
    { kind: "heading", id: "performance", text: "Performance" },
    {
      kind: "paragraph",
      text: "Numbers from the bench app's real-client harness (`node:net` / `node:dgram` / `node:tls`) on loopback, Apple silicon. The TCP and TLS figures are a single connection streaming; HTTP is the plaintext request benchmark. The prebuilt addon is a release build — a debug build is far slower.",
    },
    {
      kind: "table",
      headers: ["Transport", "Measurement", "Result"],
      rows: [
        ["HTTP/1.1", "throughput", "~99k req/s (plaintext)"],
        ["TCP", "echo throughput", "~2.5 GB/s"],
        ["TCP", "connection accepts", "~32k conns/sec"],
        ["TCP", "round-trip p50 / p99", "0.033 ms / 0.052 ms"],
        ["TLS 1.3", "decrypt throughput", "~1.35 GB/s (cipher-bound)"],
        ["UDP", "round-trip p50 / p99", "0.034 ms / 0.080 ms"],
        ["Footprint", "RSS, single thread", "~49 MB idle, ~75 MB under a flood"],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "TLS reads are record-batched — many records decrypted per libuv read into one dispatch — so throughput is bound by the AES-GCM cipher, not by N-API crossings. There is no TLS session resumption yet: every connection runs a full TLS 1.3 handshake.",
    },
    { kind: "heading", id: "what-runs-where", text: "What runs where" },
    {
      kind: "paragraph",
      text: "The shared, heavy logic is native: HTTP parsing, routing, the MIME table, ETag and header assembly, static serving, WebSocket framing, and compression negotiation. The TypeScript layer is the developer API plus the unavoidable Node bits: the handler pipeline and `zlib` for compression.",
    },
    {
      kind: "paragraph",
      text: "That line is drawn on purpose, and it is measured. Building a parsed request object in Zig and handing it to V8 means ~20 N-API calls per request — slower than letting V8's own C++ `URLSearchParams`, `Headers`, and `JSON` do it. So query, header, cookie, and JSON parsing stay in TypeScript, and the request object parses them lazily on first access.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "You never touch Zig. It ships as a prebuilt native addon for 11 platforms and loads automatically; `npm install` fetches the right one.",
    },
    { kind: "heading", id: "scope", text: "Scope: one server per process" },
    {
      kind: "paragraph",
      text: "The native engine holds the listening socket as process-global state, so one process serves one app. A second `app.listen()` clobbers the first. To use more cores, run more processes (or workers) and let the OS balance them — set `reusePort: true` so several processes can bind the same port. This is the [application](/docs/application) model and the one rule to keep in mind.",
    },
    { kind: "heading", id: "next", text: "Next steps" },
    {
      kind: "list",
      items: [
        "[Installation](/docs/installation) — add the package and supported platforms.",
        "[Quick start](/docs/quick-start) — a guided tour: routes, params, body, a hook, a plugin.",
        "[The application](/docs/application) — `createApp`, `listen`, `register`, `decorate`, lifecycle.",
        "[Routing](/docs/routing) — methods, params, wildcards, and groups.",
        "[TCP](/docs/tcp) & [HTTPS](/docs/https) — raw sockets, TLS 1.3 termination, and mutual TLS.",
        "[UDP](/docs/udp) — datagrams, per-packet AES-256-GCM, and Noise sessions.",
      ],
    },
  ],
};
