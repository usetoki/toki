// Custom 404 (catch-all route) + onError mapping thrown values to responses.
// Run: npx tsx examples/08-errors.ts
// curl -i http://127.0.0.1:3008/boom   # 500   curl -i http://127.0.0.1:3008/bad   # 400

import { Toki, reply, type TokiRequest } from "../ts";

const PORT = 3008;

class ValidationError extends Error {
  override readonly name = "ValidationError";
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const app = new Toki();

app.onError((error: unknown, req: TokiRequest | null) => {
  const requestId = req?.id ?? null;
  if (error instanceof ValidationError) {
    return reply.json({ error: error.message, requestId }, { status: error.status });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return reply.json({ error: "internal", detail, requestId }, { status: 500 });
});

app.get("/ok", () => reply.json({ ok: true }));

app.get("/boom", () => {
  throw new Error("kaboom");
});

app.get("/bad", () => {
  throw new ValidationError("name is required");
});

// Catch-all for unmatched GETs. The native router always prefers a more specific route,
// so this never shadows the routes above; trailing "*" needs >=1 segment, so "/" is not
// covered. A path no route matches still gets the native default 404.
app.get("/*", (req) => reply.json({ error: "not found", path: req.path }, { status: 404 }));

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
