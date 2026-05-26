// Runtime tuning: worker threads and the per-connection limit options on listen().
// Run: npx tsx examples/18-tuning.ts
// curl http://127.0.0.1:3018/    curl -X POST http://127.0.0.1:3018/echo -d 'hello toki'

import { cpus } from "node:os";

import { Toki, reply, type ListenOptions } from "../ts";

const PORT = 3018;

const app = new Toki();

app.get("/", () => reply.json({ ok: true, cpus: cpus().length }));
app.post("/echo", (req) => reply.text(req.text()));

async function main(): Promise<void> {
  const options: ListenOptions = {
    port: PORT,
    host: "127.0.0.1",
    workerThreads: Math.max(1, cpus().length), // omit for one per core; 1 = single-threaded
    maxHeaderBytes: 64 * 1024,
    maxBodyBytes: 8 * 1024 * 1024,
    maxHeaders: 64,
    readBufferBytes: 4 * 1024,
    readTimeoutMs: 30_000, // 0 disables; guards against slow-loris clients
    shutdownTimeoutMs: 10_000, // 0 waits forever
    tcpNodelay: true, // disable Nagle for lower latency on small responses
  };

  const server = await app.listen(options);
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
