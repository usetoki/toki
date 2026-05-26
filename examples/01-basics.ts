// Routing: path params, query string, and the same path under several verbs.
// Run: npx tsx examples/01-basics.ts
// curl 'http://127.0.0.1:3001/search?q=toki&limit=5'

import { Toki, reply } from "../ts";

const PORT = 3001;

const app = new Toki();

app.get("/", () => reply.text("Toki basics. Try /hello, /users/42, /search?q=hi"));
app.get("/hello", () => reply.html("<h1>Hello from Toki</h1>"));

app.get("/users/:id", (req) => {
  const id = req.params.id ?? "unknown";
  return reply.json({ id, name: `user-${id}` });
});

app.get("/search", (req) => {
  const q = req.query.get("q") ?? "";
  const limit = Number(req.query.get("limit") ?? "10");
  return reply.json({ query: q, limit, all: Object.fromEntries(req.query) });
});

app.post("/items", () => reply.json({ created: true }, { status: 201 }));
app.put("/items/:id", (req) => reply.json({ updated: req.params.id ?? null }));
app.delete("/items/:id", (req) => reply.json({ deleted: req.params.id ?? null }));

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
