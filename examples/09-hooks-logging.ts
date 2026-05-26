// Full hook pipeline + per-request timing, using req.id and req.log.
// Run: npx tsx examples/09-hooks-logging.ts
// curl -i http://127.0.0.1:3009/work    curl -i 'http://127.0.0.1:3009/work?fail=1'

import { Toki, reply, type TokiRequest, type TokiResponse } from "../ts";

const PORT = 3009;

const app = new Toki({ logger: true });

const startedAt = new Map<string, number>();

app.addHook("onRequest", (req: TokiRequest) => {
  startedAt.set(req.id, performance.now());
  req.log.info({ method: req.method, path: req.path }, "request received");
});

app.addHook("preHandler", (req: TokiRequest): TokiResponse | void => {
  if (req.query.get("fail") === "1") {
    return reply.json({ error: "rejected in preHandler" }, { status: 400 });
  }
});

app.addHook("onResponse", (req: TokiRequest, res: TokiResponse) => {
  const start = startedAt.get(req.id);
  startedAt.delete(req.id);
  const durationMs =
    start === undefined ? 0 : Math.round((performance.now() - start) * 1000) / 1000;
  res.headers.set("x-response-time", `${durationMs}ms`);
  res.headers.set("x-request-id", req.id);
  req.log.info({ status: res.status, durationMs }, "request completed");
});

app.get("/work", () => reply.json({ done: true }));

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
