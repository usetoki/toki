import type { DocPage } from "../../types";

export const quickStartPage: DocPage = {
  slug: "quick-start",
  title: "Quick start",
  description: "Build a small but real toki server with routing, JSON, and a body.",
  blocks: [
    {
      kind: "paragraph",
      text: "Create an app with `createApp()`, register routes, and call `listen()`. The handler returns a value or a `reply.*` result; toki turns it into a response.",
    },
    {
      kind: "code",
      snippet: {
        filename: "server.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp({ logger: "info" });

app.get("/", () => reply.text("Hello, World!"));

app.get("/users/:id", (req) => {
  return reply.json({ id: req.params.id });
});

app.post("/users", (req) => {
  const body = req.json<{ name: string }>();
  return reply.json({ created: body.name }, 201);
});

app.listen(3000);
console.log("listening on http://127.0.0.1:3000");`,
      },
    },
    { kind: "heading", id: "run-it", text: "Run it" },
    {
      kind: "paragraph",
      text: "Node 22+ runs TypeScript directly via type-stripping, so no build step is needed:",
    },
    {
      kind: "code",
      snippet: { filename: "terminal", language: "bash", code: "node server.ts" },
    },
    { kind: "heading", id: "returning-responses", text: "Returning responses" },
    {
      kind: "paragraph",
      text: "A handler can return a `reply.*` value, a plain object (sent as JSON), or a string (sent as text). Returning a `Promise` keeps the request on the async path; everything else stays synchronous and fast.",
    },
    {
      kind: "code",
      snippet: {
        filename: "responses.ts",
        language: "ts",
        code: `app.get("/text", () => "plain string");          // text/plain
app.get("/obj", () => ({ ok: true }));            // application/json
app.get("/made", () => reply.json({ id: 1 }, 201)); // explicit status`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "`app.listen()` is synchronous — it binds the socket and returns once the server is accepting connections. There is no callback to wait for.",
    },
  ],
};
