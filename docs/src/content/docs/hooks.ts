import type { DocPage } from "../../types";

export const hooksPage: DocPage = {
  slug: "hooks",
  title: "Hooks & lifecycle",
  description: "The request lifecycle and the hooks you can tap at each phase.",
  blocks: [
    {
      kind: "paragraph",
      text: "Hooks run at fixed points around a handler. Register them with `addHook(name, fn)` on the app or any scope; outer scopes run before inner ones. A request hook that returns a `reply.*` value short-circuits — the handler never runs.",
    },
    { kind: "heading", id: "order", text: "Order" },
    {
      kind: "table",
      headers: ["Hook", "When", "Can short-circuit"],
      rows: [
        ["`onRequest`", "First, before parsing", "Yes"],
        ["`preParsing`", "Before the body is read", "Yes"],
        ["`preValidation`", "Before schema validation", "Yes"],
        ["`preHandler`", "Right before the handler", "Yes"],
        ["`preSerialization`", "On the value, before it becomes a response", "Transforms it"],
        ["`onSend`", "On the built response, before the wire", "Transforms it"],
        ["`onResponse`", "After the response is sent", "No"],
        ["`onTimeout`", "When an async handler times out", "No"],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "hooks.ts",
        language: "ts",
        code: `app.addHook("onRequest", (req) => {
  req.log.info("incoming", { method: req.method, path: req.path });
});

app.addHook("preHandler", (req) => {
  if (!req.headers.get("authorization")) return reply.empty(401); // short-circuit
});

app.addHook("onResponse", (req, res) => {
  req.log.info("done", { status: res.status });
});`,
      },
    },
    { kind: "heading", id: "transforming", text: "Transforming the response" },
    {
      kind: "paragraph",
      text: "`preSerialization` sees the plain value a handler returned (before it becomes a `reply`), and `onSend` sees the built response — both can return a replacement. `compression()` is an `onSend` hook.",
    },
    {
      kind: "code",
      snippet: {
        filename: "compress.ts",
        language: "ts",
        code: `import { compression } from "@usetoki/toki";

app.addHook("onSend", compression());`,
      },
    },
  ],
};
