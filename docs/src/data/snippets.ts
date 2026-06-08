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

const TCP_TLS_SNIPPET: Snippet = {
  filename: "tls.ts",
  language: "ts",
  code: `import { readFileSync } from "node:fs";
import { createTcpServer } from "@usetoki/toki";

// TLS 1.3 is terminated in the native engine — the handler only sees plaintext.
const server = createTcpServer(
  (socket) => {
    // socket.authorized is true once a client cert verified against the CA below.
    socket.on("data", (chunk) => socket.write(chunk)); // echo
  },
  {
    tls: {
      cert: readFileSync("cert.pem"), // leaf first, then intermediates
      key: readFileSync("key.pem"),
      requestCert: true, // mutual TLS: ask for a client certificate
      rejectUnauthorized: true, // and require it to verify against the CA
      ca: readFileSync("ca.pem"),
    },
  },
);

const { port } = server.listen(9443, "127.0.0.1");`,
};

const SECURE_UDP_SNIPPET: Snippet = {
  filename: "secure-udp.ts",
  language: "ts",
  code: `import { createSecureUdpServer, connectSecureUdp, generateKeyPair } from "@usetoki/toki";

const serverKey = generateKeyPair(); // share serverKey.publicRaw out-of-band

const server = createSecureUdpServer({
  staticKey: serverKey,
  onMessage: (msg, session) => session.send("pong:" + msg.toString()),
});
const { port } = server.bind(9102, "127.0.0.1");

// Each session: X25519 mutual auth, AES-256-GCM, forward secrecy, replay protection.
const session = await connectSecureUdp({ staticKey: generateKeyPair() }, port, "127.0.0.1");
session.on("message", (m) => console.log(m.toString())); // "pong:ping"
session.send("ping");`,
};

export const EXAMPLE_TABS: readonly SnippetTab[] = [
  { id: "routing", label: "Routing & validation", snippet: ROUTING_SNIPPET },
  { id: "websocket", label: "WebSockets", snippet: WEBSOCKET_SNIPPET },
  { id: "middleware", label: "Middleware & plugins", snippet: MIDDLEWARE_SNIPPET },
  { id: "tcp-tls", label: "TCP & TLS", snippet: TCP_TLS_SNIPPET },
  { id: "secure-udp", label: "Secure UDP", snippet: SECURE_UDP_SNIPPET },
];
