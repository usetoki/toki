// Bearer-token auth via a preHandler hook; returning a response short-circuits the handler.
// Run: npx tsx examples/06-auth.ts
// curl -i -H 'authorization: Bearer s3cr3t' http://127.0.0.1:3006/private

import { Toki, reply, type TokiRequest, type TokiResponse } from "../ts";

const PORT = 3006;
const VALID_TOKEN = "s3cr3t";

const app = new Toki();

function bearerToken(req: TokiRequest): string | null {
  const [scheme, token] = (req.headers.get("authorization") ?? "").split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function requireAuth(req: TokiRequest): TokiResponse | void {
  if (bearerToken(req) !== VALID_TOKEN) {
    return reply.json(
      { error: "unauthorized" },
      { status: 401, headers: { "www-authenticate": 'Bearer realm="toki"' } },
    );
  }
}

app.get("/public", () => reply.json({ ok: true, area: "public" }));

// Scope the gate to a group so it guards only what's registered inside it.
app.group("/", (secured) => {
  secured.addHook("preHandler", requireAuth);
  secured.get("/private", () => reply.json({ ok: true, area: "private" }));
});

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
