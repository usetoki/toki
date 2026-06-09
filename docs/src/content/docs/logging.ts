import type { DocPage } from "../../types";

export const loggingPage: DocPage = {
  slug: "logging",
  title: "Logging",
  description: "Configure the app logger and use the per-request logger.",
  blocks: [
    {
      kind: "paragraph",
      text: "toki ships a small structured logger. Set `logger` on `createApp` to a level string, `false` (or omit) to silence it, or your own `Logger`. Logging is opt-in: the default is the silent logger, so it costs nothing until you turn it on. Every request exposes `req.log`, the same configured logger, ready for handlers and hooks.",
    },
    {
      kind: "code",
      snippet: {
        filename: "logger.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp({ logger: "info" });
// "debug" | "info" | "warn" | "error" | false | a custom Logger

app.get("/", (req) => {
  req.log.info("handling root", { ua: req.headers.get("user-agent") });
  return reply.text("ok");
});`,
      },
    },
    { kind: "heading", id: "levels", text: "Levels and output" },
    {
      kind: "paragraph",
      text: "The built-in console logger writes one JSON object per line. Entries below the configured level are dropped. `error` and `warn` go to stderr; `debug` and `info` go to stdout, so you can route them separately.",
    },
    {
      kind: "table",
      headers: ["Level", "Use for", "Stream"],
      rows: [
        ["`debug`", "verbose tracing", "stdout"],
        ["`info`", "normal request flow", "stdout"],
        ["`warn`", "recoverable problems", "stderr"],
        ["`error`", "failures", "stderr"],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "fields.ts",
        language: "ts",
        code: `// each method takes a message and an optional fields object
req.log.info("user login", { userId: 42, ip: req.ip });
// => {"level":"info","msg":"user login","userId":42,"ip":"203.0.113.7"}

req.log.warn("retrying upstream", { attempt: 2 });
req.log.error("payment failed", { orderId, error: String(err) });`,
      },
    },
    { kind: "heading", id: "child", text: "Child loggers" },
    {
      kind: "paragraph",
      text: "`logger.child(bindings)` returns a logger that stamps `bindings` onto every line. Bind a request id once and every entry is correlated, without repeating the field at each call site. `req.log` is the app logger, not pre-bound to the request; derive a child when you want correlation.",
    },
    {
      kind: "code",
      snippet: {
        filename: "child.ts",
        language: "ts",
        code: `app.addHook("onRequest", (req) => {
  // attach a request-scoped logger every later step can reuse
  (req as any).log = req.log.child({ reqId: req.id, path: req.path });
});

app.get("/orders/:id", (req) => {
  req.log.info("fetching order", { id: req.params.id });
  // => {"level":"info","msg":"fetching order","reqId":"3","path":"/orders/9","id":"9"}
  return reply.json({ id: req.params.id });
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "`child` merges bindings, so you can layer them: a service-wide child for `{ service: \"api\" }`, then a per-request child for `{ reqId }`. Inner bindings win on a key clash.",
    },
    { kind: "heading", id: "custom", text: "Custom logger" },
    {
      kind: "paragraph",
      text: "A `Logger` is any object with `debug` / `info` / `warn` / `error` (each taking a message and an optional fields object) plus a `child(bindings)` method. `createConsoleLogger(level)` builds the default JSON-line logger; `silentLogger` discards everything. Pass your own to bridge to pino, OpenTelemetry, or any sink.",
    },
    {
      kind: "code",
      snippet: {
        filename: "custom.ts",
        language: "ts",
        code: `import { createApp, createConsoleLogger, silentLogger } from "@usetoki/toki";
import type { Logger } from "@usetoki/toki";

// the built-in logger, configured directly (same as logger: "debug")
const app = createApp({ logger: createConsoleLogger("debug") });

// or bridge to your own sink
const myLogger: Logger = {
  debug: (msg, fields) => sink.write("debug", msg, fields),
  info: (msg, fields) => sink.write("info", msg, fields),
  warn: (msg, fields) => sink.write("warn", msg, fields),
  error: (msg, fields) => sink.write("error", msg, fields),
  child: (bindings) => makeChild(myLogger, bindings),
};
createApp({ logger: myLogger });

// silence a logger entirely (e.g. in tests)
createApp({ logger: silentLogger });`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "Internal failures — a handler that throws, a stream that breaks, a hook that rejects — are logged through this same logger at `error`. Set `logger: \"error\"` in production if you only want those.",
    },
  ],
};
