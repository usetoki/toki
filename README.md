# 🌀 Toki

**The fastest HTTP framework for Node.js and Bun.** ⚡

Toki gives you a clean, fully-typed TypeScript API on top of a native HTTP engine
written in Rust. Routing, parsing, uploads, static files, and compression all run
in native code — your handlers stay in JavaScript. Hot routes can be answered
**entirely in Rust**, never crossing into JS at all.

```ts
import { Toki, reply } from "@usetoki/toki";

const app = new Toki({ logger: true });

app.get("/", () => reply.text("Hello, World!"));
app.get("/users/:id", (req) => reply.json({ id: req.params.id }));

const server = await app.listen({ port: 3000 });
console.log(`listening on http://127.0.0.1:${server.port}`);
```

---

## ✨ Why Toki

- 🦀 **Native engine** — HTTP/1.1 parsing, routing, and I/O run in Rust, not JS.
- ⚡ **Native fast-path** — `app.native.*` routes are pre-rendered to bytes and served straight from the worker pool with zero per-request allocation.
- 🧩 **Fully typed** — strict TypeScript, no `any`, great editor autocompletion.
- 🪶 **Tiny footprint** — single-thread server runs in ~38 MB and beats everything in its class.
- 🔌 **Batteries included** — routing, hooks, middleware, route groups, cookies, CORS, security headers, logging, request IDs.
- 📦 **Native body parsing** — JSON, urlencoded, and `multipart/form-data` parsed in Rust, with file uploads + size/extension limits enforced before your code runs.
- 🗂️ **Native static files** — `ETag`/`304`, `Range`, MIME, traversal-safe.
- 🗜️ **Native compression** — gzip + brotli, with native routes pre-compressed once at startup.
- 🔒 **TLS & Unix sockets** — HTTPS and `unix:` binding built in.
- 🟢 **Runs on Node.js and Bun** — same ABI-stable native addon.

## 🚀 Install

```bash
npm install @usetoki/toki
yarn add @usetoki/toki
pnpm add @usetoki/toki
bun add @usetoki/toki
```

Prebuilt binaries ship for macOS (x64/arm64), Linux (x64/arm64), and Windows (x64) — no compiler needed.

## ⚡ Two ways to respond

```ts
// Native: rendered once in Rust, served with no JS on the request path.
app.native.json("/health", { status: "ok" });

// Dynamic: your JS handler runs, with the full middleware/hook pipeline.
app.get("/users/:id", (req) => reply.json({ id: req.params.id }));
```

## 📖 Features at a glance

```ts
// Middleware + hooks
app.use(cors());
app.use(securityHeaders());
app.addHook("onRequest", (req) => req.log.info("incoming"));

// Route groups with shared prefix + scoped hooks
app.group("/api/v1", (api) => {
  api.addHook("preHandler", requireAuth);
  api.get("/me", (req) => reply.json({ id: req.params.id }));
});

// Native form parsing + uploads (limits enforced in Rust)
app.post("/upload", (req) => reply.json({ files: req.form?.files.length ?? 0 }));

// Native static files
app.static("/assets", "./public");

await app.listen({
  port: 3000,
  parseForms: true,
  uploadDir: "./uploads",
  allowedFileExtensions: ["png", "jpg", "pdf"],
  maxFileSize: 5 * 1024 * 1024,
  compression: true,
});
```

**Request:** `req.method`, `req.path`, `req.params`, `req.query`, `req.headers`,
`req.cookies`, `req.body`, `req.form`, `req.id`, `req.log`, `req.text()`, `req.json<T>()`.

**Reply:** `reply.text / html / json / empty / redirect`, plus `reply.cookie(...)`.

**Built-in middleware:** `cors(options)`, `securityHeaders(options)`.

Every response carries `X-Powered-By: Toki` by default — override it with
`defaultHeaders`, or turn it off with `poweredBy: false`.

## ⚙️ `listen` options

| Option | Default | Description |
| --- | --- | --- |
| `port` | — | Port; `0` picks a free one. |
| `host` | `127.0.0.1` | Bind interface. |
| `workerThreads` | per CPU | Runtime size; `1` = single-threaded. |
| `maxHeaderBytes` | 65536 | Max request head size. |
| `maxBodyBytes` | 16 MiB | Max body for dynamic routes. |
| `maxHeaders` | 64 | Max headers per request. |
| `readTimeoutMs` | 30000 | Per-read stall timeout; `0` disables. |
| `shutdownTimeoutMs` | 10000 | Graceful drain wait; `0` waits forever. |
| `parseForms` | `false` | Parse urlencoded/multipart bodies natively. |
| `maxFileSize` / `allowedFileExtensions` / `uploadDir` | — | Upload limits + destination (Rust-enforced). |
| `compression` / `compressionMinSize` | `false` / 1024 | gzip/brotli negotiation. |
| `gzipLevel` / `brotliQuality` / `brotliWindow` / `brotliQualityStatic` | 6 / 5 / 22 / 11 | Compression tuning. |
| `tlsCert` / `tlsKey` | — | PEM cert + key → HTTPS. |
| `unixPath` | — | Bind a Unix-domain socket. |
| `defaultHeaders` | — | Headers added to every response. |
| `poweredBy` | `"Toki"` | `X-Powered-By` value; `false` disables it. |

## 🟢 Runtimes

Toki runs on **Node.js 20+** and **Bun 1.1+** — the addon is an ABI-stable
Node-API binary loaded the same way by both.

```bash
node app.js     # Node.js
bun  app.ts     # Bun
```

## 🔧 Build from source

Requires a recent Rust toolchain and Node.js 20+.

```bash
npm install
npm run build      # native addon (release) + TypeScript
npm test
npm run lint       # rustfmt + clippy + tsc + prettier
```

## 📂 Layout

| Folder | What |
| --- | --- |
| `core/` | Rust engine (Node-API addon). |
| `ts/` | TypeScript framework layer → `dist/`. |
| `bindings/` | Generated loader, types, and binary. |
| `examples/` | 19 runnable examples, from routing to uploads to TLS. |

## 🧪 Examples

```bash
npx tsx examples/01-basics.ts
```

Browse [`examples/`](./examples) for forms, uploads, auth, cookies, CORS, groups,
static files, rate limiting, compression, HTTPS, Unix sockets, and graceful shutdown.

---

Built on [Tokio](https://tokio.rs) 🦀 — the asynchronous Rust runtime that powers Toki's native engine.

## License

MIT
