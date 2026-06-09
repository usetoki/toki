import type { DocPage } from "../../types";

export const applicationPage: DocPage = {
  slug: "application",
  title: "The application",
  description: "Create an app, configure it, register plugins and decorators, and manage its lifecycle.",
  blocks: [
    {
      kind: "paragraph",
      text: "`createApp()` returns a `Toki` instance, the root of your application. It is itself a registration scope, so routes, hooks, middleware, decorators, and plugins are all registered on it. Child scopes created by [`register`](/docs/plugins) inherit its hooks but encapsulate their own.",
    },
    { kind: "heading", id: "create", text: "Creating an app" },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";

const app = createApp({
  logger: "info",        // "debug" | "info" | "warn" | "error" | false | a custom Logger
  requestTimeoutMs: 0,   // 408 a stalled async handler after N ms; 0 disables
});`,
      },
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Effect"],
      rows: [
        [
          "`logger`",
          "`LogLevel` | `Logger` | `false`",
          "`false`",
          "A level for the built-in console logger, a custom [Logger](/docs/logging), or `false` for silence. Reachable as `req.log`.",
        ],
        [
          "`requestTimeoutMs`",
          "`number`",
          "`0`",
          "Reply `408` and run `onTimeout` hooks if an async handler runs longer than this. `0` disables. Only affects handlers that return a `Promise`.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "These two are the only constructor options. Everything about the network socket (host, port, limits, TLS, rate limiting) is a `listen` option, below.",
    },
    { kind: "heading", id: "listen", text: "Listening" },
    {
      kind: "paragraph",
      text: "`listen(port, options?)` binds the socket and returns a handle. It is synchronous: the server is accepting connections by the time it returns. Pass `0` as the port to get an OS-assigned one; the chosen port comes back on `handle.port`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "listen.ts",
        language: "ts",
        code: `const handle = app.listen(3000, { host: "127.0.0.1" });
console.log(\`listening on port \${handle.port}\`);

// later, to stop serving (runs onClose hooks, then closes connections):
handle.close();`,
      },
    },
    {
      kind: "paragraph",
      text: "`listen` returns a `ListenHandle`:",
    },
    {
      kind: "table",
      headers: ["Member", "Type", "Meaning"],
      rows: [
        ["`port`", "`number`", "The bound port. Resolves `0` to the OS-assigned port."],
        ["`close()`", "`() => void`", "Run `onClose` hooks, then stop accepting and close every live connection."],
      ],
    },
    {
      kind: "paragraph",
      text: "Common `listen` options — see [Server options](/docs/server-options) for the full set:",
    },
    {
      kind: "table",
      headers: ["Option", "Default", "Effect"],
      rows: [
        ["`host`", "`\"0.0.0.0\"`", "Interface to bind."],
        ["`maxBodyBytes`", "1 MiB", "Reject larger request bodies."],
        ["`headerTimeoutMs`", "off", "Close a connection that sends no data in time."],
        ["`backlog`", "512", "Pending-connection queue depth."],
        ["`reusePort`", "`false`", "`SO_REUSEPORT` so multiple processes can share the port."],
        ["`unixPath`", "—", "Bind a unix-domain socket instead of TCP (the port is ignored)."],
        ["`rateLimit`", "off", "Native per-IP `{ max, windowMs }`; over-limit gets a `429` before JS."],
        ["`tls`", "off", "`{ cert, key }` to terminate [HTTPS](/docs/https) directly (TLS 1.3)."],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "tuned.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";

app.listen(8443, {
  host: "0.0.0.0",
  maxBodyBytes: 5 * 1024 * 1024,            // 5 MiB
  rateLimit: { max: 100, windowMs: 60_000 }, // 100 req/min per IP
  tls: {
    cert: readFileSync("cert.pem"),
    key: readFileSync("key.pem"),
  },
});`,
      },
    },
    { kind: "heading", id: "one-per-process", text: "One app per process" },
    {
      kind: "callout",
      tone: "warning",
      text: "The native engine holds global server state, so one process serves a single app. A second `listen()` clobbers the first. To scale across cores, run several processes (or worker threads) and set `reusePort: true` so they share the port; the kernel balances connections.",
    },
    { kind: "heading", id: "decorate", text: "Decorating: app and request" },
    {
      kind: "paragraph",
      text: "Attach shared services to the app with `decorate(name, value)`; it lives on the instance, so plugins and handlers can reach it through the scope. Attach per-request data with `decorateRequest(name, value)` and every `req` in that scope gets the property. See [Decorators](/docs/decorators).",
    },
    {
      kind: "code",
      snippet: {
        filename: "decorate.ts",
        language: "ts",
        code: `const app = createApp();

// app-global: a shared client, config, etc.
app.decorate("db", makeDb());

// per-request: a default attached to every req in this scope
app.decorateRequest("user", null);

app.get("/me", (req) => {
  // (req as { user: User | null }) — set earlier by an auth hook
  return reply.json({ user: (req as any).user });
});`,
      },
    },
    { kind: "heading", id: "register", text: "Registering plugins" },
    {
      kind: "paragraph",
      text: "`register(plugin, opts?)` loads a plugin into a fresh child scope. Routes, hooks, and decorators it adds are encapsulated there and do not leak to the parent. `opts.prefix` mounts the plugin's routes under a path; any other keys are passed to the plugin. See [Plugins](/docs/plugins).",
    },
    {
      kind: "code",
      snippet: {
        filename: "register.ts",
        language: "ts",
        code: `import type { TokiInstance, PluginOptions } from "@usetoki/toki";

function api(app: TokiInstance, opts: PluginOptions) {
  app.get("/health", () => ({ ok: true }));
}

app.register(api, { prefix: "/v1" }); // GET /v1/health`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "If any registered plugin is `async`, call `await app.ready()` before `listen()`. A synchronous `listen()` throws when it meets an async plugin, since it cannot await it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "async-plugin.ts",
        language: "ts",
        code: `app.register(async (app) => {
  const cache = await connectCache();
  app.decorate("cache", cache);
});

await app.ready();   // loads async plugins
app.listen(3000);`,
      },
    },
    { kind: "heading", id: "lifecycle", text: "Lifecycle" },
    {
      kind: "list",
      items: [
        "`app.onReady(fn)` — runs once during `listen`, before serving begins.",
        "`app.onClose(fn)` — runs when the handle's `close()` is called, before connections drop.",
        "`await app.ready()` — load async plugins before `listen` (see above).",
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "lifecycle.ts",
        language: "ts",
        code: `app.onReady(() => app.log.info("warming up"));
app.onClose(async () => {
  await flushMetrics();
  app.log.info("shutting down");
});

const handle = app.listen(3000);

// graceful shutdown
process.on("SIGTERM", () => handle.close());`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "`onReady`/`onClose` hooks are run defensively: a throw or rejection is logged, not propagated, so one bad hook can't take down `listen` or `close`.",
    },
    { kind: "heading", id: "inject", text: "Testing with inject" },
    {
      kind: "paragraph",
      text: "`app.inject(options)` drives a request through the full native path over loopback, auto-binding an ephemeral port if the app isn't already listening. It returns the captured response. No real client, no port juggling. See [Testing](/docs/testing).",
    },
    {
      kind: "code",
      snippet: {
        filename: "inject.ts",
        language: "ts",
        code: `app.get("/users/:id", (req) => reply.json({ id: req.params.id }));

const res = await app.inject({ method: "GET", url: "/users/42" });
console.log(res.statusCode);      // 200
console.log(res.json());          // { id: "42" }`,
      },
    },
    {
      kind: "paragraph",
      text: "From here, register your [routes](/docs/routing), add [validation](/docs/validation) and [hooks](/docs/hooks), and reach for the [plugins](/docs/plugins-overview) you need.",
    },
  ],
};
