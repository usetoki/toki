// Route groups for /api versioning, with a nested group and a group-scoped auth hook.
// Run: npx tsx examples/10-groups-versioning.ts
// curl http://127.0.0.1:3010/api/v2/ping    curl -i http://127.0.0.1:3010/api/v2/admin/stats   # 401

import { Toki, reply, type TokiRequest, type TokiResponse } from "../ts";

const PORT = 3010;
const ADMIN_KEY = "admin-key";

const app = new Toki();

app.group("/api/v1", (v1) => {
  v1.get("/ping", () => reply.json({ version: "v1", pong: true }));
  v1.get("/users/:id", (req) => reply.json({ version: "v1", id: req.params.id ?? null }));
});

app.group("/api/v2", (v2) => {
  v2.get("/ping", () => reply.json({ version: "v2", pong: true, ts: Date.now() }));
  v2.get("/users/:id", (req) =>
    reply.json({ version: "v2", id: req.params.id ?? null, links: { self: req.path } }),
  );

  // Scoped to /api/v2/admin/* only; group hooks run after the root's.
  v2.group("/admin", (admin) => {
    admin.addHook("preHandler", (req: TokiRequest): TokiResponse | void => {
      if (req.headers.get("authorization") !== `Bearer ${ADMIN_KEY}`) {
        return reply.json({ error: "admin token required" }, { status: 401 });
      }
    });
    admin.get("/stats", () =>
      reply.json({ version: "v2", uptimeMs: Math.round(process.uptime() * 1000) }),
    );
  });
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
