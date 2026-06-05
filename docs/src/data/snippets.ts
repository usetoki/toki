import type { Snippet, SnippetTab } from "../types";

export const INSTALL_SNIPPET: Snippet = {
  filename: "terminal",
  language: "bash",
  code: "npm install @usetoki/toki",
};

export const HELLO_SNIPPET: Snippet = {
  filename: "server.ts",
  language: "ts",
  code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp();

app.get("/", () => reply.text("Hello, World!"));
app.get("/users/:id", (req) => reply.json({ id: req.params.id }));

app.listen(3000);
console.log("listening on http://127.0.0.1:3000");`,
};

const ROUTING_SNIPPET: Snippet = {
  filename: "routing.ts",
  language: "ts",
  code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp({ logger: "info" });

app.get("/users/:id", (req) => reply.json({ id: req.params.id }));

app.post(
  "/users",
  {
    schema: {
      body: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", minLength: 2 } },
      },
    },
  },
  (req) => reply.json({ created: req.json().name }, 201),
);

app.listen(3000);`,
};

const WEBSOCKET_SNIPPET: Snippet = {
  filename: "chat.ts",
  language: "ts",
  code: `import { createApp } from "@usetoki/toki";

const app = createApp();

app.ws("/chat", { protocols: ["chat"] }, (socket, req) => {
  socket.send("welcome " + req.ip);

  socket.on("message", (data, isBinary) => {
    socket.send(isBinary ? data : "echo: " + data.toString());
  });
  socket.on("close", (code, reason) => console.log("closed", code, reason));
});

app.listen(3000, { wsCompression: true });`,
};

const MIDDLEWARE_SNIPPET: Snippet = {
  filename: "api.ts",
  language: "ts",
  code: `import { createApp, reply, cors, compression, jwtAuth } from "@usetoki/toki";

const app = createApp();

app.use(cors({ origin: ["https://app.example"] }));
app.addHook("onSend", compression());

app.group("/api/v1", (api) => {
  api.use(jwtAuth({ secret: process.env.JWT_SECRET }));
  api.get("/me", (req) => reply.json(req.user));
});

app.listen(3000, { rateLimit: { max: 100, windowMs: 60_000 } });`,
};

export const EXAMPLE_TABS: readonly SnippetTab[] = [
  { id: "routing", label: "Routing & validation", snippet: ROUTING_SNIPPET },
  { id: "websocket", label: "WebSockets", snippet: WEBSOCKET_SNIPPET },
  { id: "middleware", label: "Middleware & plugins", snippet: MIDDLEWARE_SNIPPET },
];
