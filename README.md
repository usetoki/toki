<p align="center">
  <img src="assets/toki-logo.png" alt="Toki" width="280">
</p>

<p align="center">
  <strong>A blazing-fast HTTP framework for Node.js.</strong> ⚡
</p>

<p align="center">
  <a href="https://usetoki.github.io/toki/"><strong>📖 Documentation</strong></a>
</p>

<p align="center">
  A clean, fully-typed TypeScript API on top of a native HTTP engine written in
  <strong>Zig</strong>. Parsing, routing, static files, and compression run in native
  code; your handlers stay in JavaScript.
</p>

The engine runs on Node's **own libuv loop** and calls handlers **synchronously** on
the JS thread — no worker threads, no `ThreadsafeFunction`, no cross-thread hop. On
the plaintext benchmark it sustains ~99k req/s at ~49 MB RSS on a single thread.

```ts
import { createApp, reply } from "@usetoki/toki";

const app = createApp();

app.get("/", () => reply.text("Hello, World!"));
app.get("/users/:id", (req) => reply.json({ id: req.params.id }));

app.listen(3000);
console.log("listening on http://127.0.0.1:3000");
```

## ✨ Why Toki

- ⚡ **Native engine** — HTTP/1.1 parsing, routing, and I/O run in Zig, on Node's own loop.
- 🪶 **Tiny footprint** — a single-thread server in ~49 MB, ~2× leaner than `node:http`.
- 🧩 **Fully typed** — strict TypeScript, no `any`, real editor autocompletion.
- 🔌 **Batteries included** — routing, hooks, middleware, route groups, plugins, cookies, CORS, security headers, logging, `req.id` / `req.ip`.
- 📦 **Body parsing** — JSON, urlencoded, and `multipart/form-data` uploads, plus pluggable content-type parsers.
- 🗂️ **Static files** — MIME, `ETag` / `304`, `HEAD`, traversal-safe, with pre-computed gzip/brotli.
- 🗜️ **Compression** — gzip + brotli, negotiated per `Accept-Encoding`, off the event loop.
- 🌊 **Streaming** — `reply.stream` over chunked transfer encoding, with native backpressure.
- 🔭 **WebSockets** — full RFC 6455 in native code: framing, masking, fragmentation, ping/pong, close codes, subprotocols, and a per-IP message-size guard.
- 🛡️ **Hardened** — schema validation, JWT, a native per-IP rate limiter, slowloris guard, configurable limits.
- 🧪 **Testable** — `app.inject()` runs a real request in-process, no port needed.

## 🚀 Install

```bash
npm install @usetoki/toki
```

Or build from source — see [Build from source](#-build-from-source). You'll need
[Zig](https://ziglang.org) 0.16.0 and Node.js 20+.

Full guides and the API reference live at **[usetoki.github.io/toki](https://usetoki.github.io/toki/)**.

## 📖 Features at a glance

```ts
import { createApp, reply, cors, securityHeaders, compression, jwtAuth } from "@usetoki/toki";

const app = createApp({ logger: "info" });

// Middleware + the full hook pipeline
app.use(cors({ origin: ["https://app.example"] }));
app.use(securityHeaders({ hsts: true }));
app.addHook("onResponse", compression());

// Route groups with a shared prefix + scoped hooks
app.group("/api/v1", (api) => {
  api.use(jwtAuth({ secret: process.env.JWT_SECRET! }));
  api.get("/me", (req) => reply.json(req.user));
});

// Encapsulated plugins
app.register(async (instance) => {
  instance.get("/health", () => ({ status: "ok" }));
}, { prefix: "/internal" });

// Schema validation (custom messages) + response serialization
app.post("/users", {
  schema: {
    body: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 2 } },
      errorMessage: { required: { name: "name is required" } },
    },
  },
}, (req) => reply.json({ created: req.json<{ name: string }>().name }, 201));

// Uploads (req.form), static files, streaming, rate limiting
app.post("/upload", (req) => reply.json({ files: req.form?.files.length ?? 0 }));
app.static("/assets", "./public");
app.get("/events", () => reply.stream(sse(), { contentType: "text/event-stream" }));

app.listen(3000, { rateLimit: { max: 100, windowMs: 60_000 } });
```

**Request:** `req.method`, `req.path`, `req.params`, `req.query`, `req.headers`,
`req.cookies`, `req.body`, `req.form`, `req.ip`, `req.hostname`, `req.protocol`,
`req.id`, `req.log`, `req.text()`, `req.json<T>()`, `await req.parseBody()`.

**Reply:** `reply.text / html / json / empty / redirect / bytes / stream`.

**Built in:** `cors()`, `securityHeaders()`, `compression()`, `signJwt` / `verifyJwt`
/ `jwtAuth`, `setErrorHandler`, `setNotFoundHandler`, `addContentTypeParser`.

## ⚙️ `listen` options

```ts
app.listen(3000, { host: "0.0.0.0", maxBodyBytes: 5_000_000 });
```

| Option | Default | Description |
| --- | --- | --- |
| `host` | `0.0.0.0` | Bind interface. Pass `0` as the port to pick a free one. |
| `maxBodyBytes` | 1 MiB | Largest accepted request body (`413` above it). |
| `maxHeaders` | 128 | Max header lines per request. |
| `backlog` | 512 | Listen backlog. |
| `headerTimeoutMs` | 0 | Close a connection stalled mid-request, in ms; `0` disables (slowloris guard). |
| `reusePort` | `false` | `SO_REUSEPORT` for kernel-balanced multi-worker scaling (Linux/BSD). |
| `rateLimit` | — | `{ max, windowMs }` — native per-IP limiter; over-limit requests get a `429` before reaching JS. |
| `unixPath` | — | Bind a unix-domain socket at this path instead of TCP (the port is ignored). Ideal for a reverse proxy → app on the same host. |
| `maxWsMessageBytes` | 16 MiB | Largest accepted WebSocket message; a larger one is closed with `1009`. |
| `wsCompression` | `false` | Offer `permessage-deflate` (RFC 7692) when a client requests it. |

`createApp({ logger, requestTimeoutMs })` configures the app; `app.listen` returns a
handle whose `close()` shuts the server down gracefully.

## 🔭 WebSockets

`app.ws(path, handler)` registers a WebSocket endpoint. The handler runs once per
connection with the live socket and the upgrade request; the framing, masking,
fragmentation, ping/pong, and close handshake all run in native code, so handlers
only ever see complete messages.

```ts
app.ws("/chat", { protocols: ["chat"] }, (socket, req) => {
  console.log(`connected from ${req.ip} as ${socket.protocol}`);

  socket.on("message", (data, isBinary) => {
    socket.send(isBinary ? data : `echo: ${data.toString()}`);
  });
  socket.on("close", (code, reason) => console.log("closed", code, reason));
});
```

- **Send:** `socket.send(string | Uint8Array)` (returns the write backlog in bytes),
  `socket.ping()`, `socket.pong()`, `socket.close(code?)`.
- **Events:** `message` `(data, isBinary)`, `close` `(code, reason)`, `ping`, `pong`,
  and `drain` (fires when a backpressured socket's write queue empties).
- **State:** `socket.data` is a free-form per-connection bag; `socket.protocol` is the
  negotiated subprotocol.
- **Compression:** set `wsCompression: true` in `listen` to offer `permessage-deflate`
  (RFC 7692). It's negotiated per connection and applied transparently — handlers send
  and receive plain data.
- The `Buffer` passed to `message` / `ping` / `pong` is a view over native memory
  valid only during the call — copy it (`Buffer.from(data)` / `data.toString()`) to keep it.

A plain `GET` to a WebSocket path (no `Upgrade` header) gets `426 Upgrade Required`.

## 🧭 Native vs JavaScript — the boundary

The shared, heavy logic is native: HTTP parsing, routing, the MIME table, ETag and
header assembly, status phrases, static serving, and compression negotiation. The
TypeScript layer is the developer API plus the unavoidable Node bits (the handler
pipeline, `fs`/`zlib` for static assets).

That line is drawn on purpose, and it's measured. Building a parsed request object in
Zig and handing it to V8 means ~20 N-API calls per request — slower than letting V8's
own C++ `URLSearchParams` / `Headers` / `JSON` do it. So query/header/cookie/JSON
parsing and schema validation stay in TypeScript: crossing the N-API boundary to
"go native" there would make it slower, which is the opposite of the point.

## 🔧 Build from source

```bash
npm install
npm run build      # native addon (ReleaseFast) + TypeScript → dist/
npm test           # zig build test + the Node suite
npm run lint       # zig fmt + tsc + prettier
```

`npm run build:debug` is a faster, unoptimized native build for iteration. The build
cross-compiles: `zig build -Dtarget=aarch64-linux-gnu` (and friends) produces the
addon for any platform from one host.

## 📂 Layout

| Folder | What |
| --- | --- |
| `src/core/` | Engine state, the libuv hot path, and server lifecycle (`engine`, `loop`, `server`). |
| `src/http/` | HTTP layer — `parser`, `router`, `request`, `response`, `static`, `stream`, `mime`. |
| `src/websocket/` | WebSocket wire format (`frame`) and the session/dispatch layer (`session`). |
| `src/security/` | The native rate limiter. |
| `src/ffi/` | Hand-declared N-API and libuv bindings. |
| `ts/` | TypeScript framework layer (`core/`, `http/`, `websocket/`, `security/`, `native/`) → `dist/`. |
| `__test__/` | Node test suite (`node:test`, run as `.ts`); Zig unit tests live in `*.test.zig` beside their module. |
| `examples/` | A runnable, self-checking example per feature. |

## 🧪 Examples

```bash
node examples/routing.ts
```

Browse [`examples/`](./examples) for routing, async handlers, hooks, groups, plugins,
validation, cookies, static files, forms, CORS, compression, rate limiting, JWT,
streaming, and graceful shutdown.

## Scope

Toki speaks HTTP/1.1. TLS and HTTP/2 are intentionally out of scope — terminate them
at a reverse proxy (nginx, Caddy), the standard production setup for Node. WebSockets
are not included.

## License

MIT — see [LICENSE](./LICENSE).
