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
      text: "The engine runs on Node's own libuv loop and calls handlers synchronously on the JS thread — no worker threads, no `ThreadsafeFunction`, no cross-thread hop. On the plaintext benchmark it sustains ~99k req/s at ~49 MB RSS on a single thread.",
    },
    { kind: "heading", id: "hello-world", text: "Hello, world" },
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
    { kind: "heading", id: "what-runs-where", text: "What runs where" },
    {
      kind: "paragraph",
      text: "The shared, heavy logic is native: HTTP parsing, routing, the MIME table, ETag and header assembly, static serving, WebSocket framing, and compression negotiation. The TypeScript layer is the developer API plus the unavoidable Node bits — the handler pipeline and `zlib` for compression.",
    },
    {
      kind: "paragraph",
      text: "That line is drawn on purpose, and it is measured. Building a parsed request object in Zig and handing it to V8 means ~20 N-API calls per request — slower than letting V8's own C++ `URLSearchParams`, `Headers`, and `JSON` do it. So query, header, cookie, and JSON parsing stay in TypeScript.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "You never touch Zig. It ships as a prebuilt native addon for 11 platforms and loads automatically — `npm install` fetches the right one.",
    },
    { kind: "heading", id: "next", text: "Next steps" },
    {
      kind: "list",
      items: [
        "[Installation](/docs/installation) — add the package and supported platforms.",
        "[Quick start](/docs/quick-start) — your first real server.",
        "[Routing](/docs/routing) — methods, params, wildcards, and groups.",
      ],
    },
  ],
};
