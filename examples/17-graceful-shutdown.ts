// Graceful shutdown: close() drains in-flight requests; the process exits on its own.
// Run: npx tsx examples/17-graceful-shutdown.ts
// curl http://127.0.0.1:3017/slow  then Ctrl-C the server: the request still completes.

import { setTimeout as delay } from "node:timers/promises";

import { Toki, reply } from "../ts";

const PORT = 3017;

const app = new Toki();

app.get("/", () => reply.text("fast"));
app.get("/slow", async () => {
  await delay(5000);
  return reply.json({ done: true, waitedMs: 5000 });
});

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT, shutdownTimeoutMs: 10_000 });
  console.log(`READY http://${server.host}:${server.port}`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n${signal} received: draining in-flight requests...`);
    // close() drains in the background; do NOT process.exit() here or in-flight
    // requests die mid-response. The event loop empties once draining finishes.
    server.close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
