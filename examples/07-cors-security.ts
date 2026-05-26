// CORS + security headers as middleware; both stage headers the dispatcher merges in.
// Run: npx tsx examples/07-cors-security.ts
// curl -i -X OPTIONS http://127.0.0.1:3007/data -H 'origin: https://app.example.com' -H 'access-control-request-method: POST'

import { Toki, cors, securityHeaders, reply } from "../ts";

const PORT = 3007;

const app = new Toki();

app.use(
  securityHeaders({
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: "default-src 'self'; img-src 'self' data:",
    frameOptions: "DENY",
  }),
);

app.use(
  cors({
    origin: ["https://app.example.com", "https://admin.example.com"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"],
    exposedHeaders: ["x-request-id"],
    credentials: true,
    maxAge: 600,
  }),
);

app.get("/data", () => reply.json({ items: [1, 2, 3] }));
app.post("/data", () => reply.json({ created: true }, { status: 201 }));

// The native router 405s an unregistered method, so the preflight needs a real OPTIONS
// route to reach JS where cors() short-circuits it. This handler runs only for a
// non-preflight OPTIONS (no Access-Control-Request-Method header).
app.options("/data", () => reply.empty(204));

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
