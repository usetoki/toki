import type { DocPage } from "../../types";

export const loggingPage: DocPage = {
  slug: "logging",
  title: "Logging",
  description: "Configure the app logger and use the per-request logger.",
  blocks: [
    {
      kind: "paragraph",
      text: "Set `logger` on `createApp` to a level string, `false` to silence it, or a custom `Logger`. Every request gets `req.log`, which tags entries with the request id.",
    },
    {
      kind: "code",
      snippet: {
        filename: "logger.ts",
        language: "ts",
        code: `const app = createApp({ logger: "info" });
// "debug" | "info" | "warn" | "error" | false | a custom Logger

app.get("/", (req) => {
  req.log.info("handling root", { ua: req.headers.get("user-agent") });
  return reply.text("ok");
});`,
      },
    },
    { kind: "heading", id: "custom", text: "Custom logger" },
    {
      kind: "paragraph",
      text: "A `Logger` is any object with `debug` / `info` / `warn` / `error` methods taking a message and an optional fields object. `createConsoleLogger(level)` builds the default; `silentLogger` discards everything.",
    },
    {
      kind: "code",
      snippet: {
        filename: "custom.ts",
        language: "ts",
        code: `import { createConsoleLogger, silentLogger } from "@usetoki/toki";

const app = createApp({
  logger: createConsoleLogger("debug"),
  // or pass your own: { debug, info, warn, error }
});`,
      },
    },
  ],
};
