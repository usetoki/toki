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
      text: "The engine runs on Node's own libuv loop and calls handlers synchronously on the JS thread — no worker threads, no `ThreadsafeFunction`, no cross-thread hop. On the plaintext benchmark it sustains ~99k req/s at ~49 MB RSS on a single thread. You write ordinary `async` functions; toki keeps them on a synchronous fast path until one actually returns a `Promise`.",
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
      text: "Run it with `node server.ts` — Node 22+ strips the types and runs the file directly, no build step. See [Installation](/docs/installation) for the supported versions and platforms.",
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
        [
          "WebSockets",
          "Native framing and per-message-deflate via [`app.ws`](/docs/websockets).",
        ],
        [
          "Static / compression / streaming",
          "[Static serving](/docs/static-files) with ETag, gzip/brotli [compression](/docs/compression), chunked [streaming](/docs/streaming) and SSE.",
        ],
        [
          "Raw transports",
          "Native [TCP](/docs/tcp) and [UDP](/docs/udp) servers on the same loop.",
        ],
        [
          "TLS & secure UDP",
          "Direct [HTTPS](/docs/https) termination (TLS 1.3) and Noise XX-encrypted UDP — no reverse proxy required.",
        ],
      ],
    },
    { kind: "heading", id: "what-runs-where", text: "What runs where" },
    {
      kind: "paragraph",
      text: "The shared, heavy logic is native: HTTP parsing, routing, the MIME table, ETag and header assembly, static serving, WebSocket framing, and compression negotiation. The TypeScript layer is the developer API plus the unavoidable Node bits — the handler pipeline and `zlib` for compression.",
    },
    {
      kind: "paragraph",
      text: "That line is drawn on purpose, and it is measured. Building a parsed request object in Zig and handing it to V8 means ~20 N-API calls per request — slower than letting V8's own C++ `URLSearchParams`, `Headers`, and `JSON` do it. So query, header, cookie, and JSON parsing stay in TypeScript, and the request object parses them lazily on first access.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "You never touch Zig. It ships as a prebuilt native addon for 11 platforms and loads automatically — `npm install` fetches the right one.",
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
      ],
    },
  ],
};
