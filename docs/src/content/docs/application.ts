import type { DocPage } from "../../types";

export const applicationPage: DocPage = {
  slug: "application",
  title: "The application",
  description: "Create an app, configure it, and start listening.",
  blocks: [
    {
      kind: "paragraph",
      text: "`createApp()` returns a `Toki` instance — the root of your application. It is itself a registration scope, so routes, hooks, middleware, and plugins are all registered on it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";

const app = createApp({
  logger: "info",        // "info" | "debug" | "warn" | "error" | false | a custom Logger
  requestTimeoutMs: 0,   // 408 a stalled async handler after N ms; 0 disables
});`,
      },
    },
    { kind: "heading", id: "listen", text: "Listening" },
    {
      kind: "paragraph",
      text: "`listen(port, options?)` binds the socket and returns a handle. It is synchronous — the server is accepting connections by the time it returns. Pass `0` as the port to get an OS-assigned one.",
    },
    {
      kind: "code",
      snippet: {
        filename: "listen.ts",
        language: "ts",
        code: `const handle = app.listen(3000, { host: "127.0.0.1" });

// later, to stop serving (runs onClose hooks, then closes connections):
handle.close();`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The native engine holds global server state, so one process serves a single app — a second `listen()` clobbers the first.",
    },
    { kind: "heading", id: "lifecycle", text: "Startup lifecycle" },
    {
      kind: "list",
      items: [
        "`app.onReady(fn)` — runs once at `listen`, before serving.",
        "`app.onClose(fn)` — runs when the handle's `close()` is called.",
        "`await app.ready()` — load async plugins before `listen` (see [Plugins](/docs/plugins)).",
      ],
    },
    {
      kind: "paragraph",
      text: "See [Server options](/docs/server-options) for the full set of `listen` tunables (limits, timeouts, rate limiting, unix sockets, WebSocket compression).",
    },
  ],
};
