// Bind a Unix-domain socket instead of TCP (unixPath); host/port are ignored.
// Run: npx tsx examples/16-unix-socket.ts
// curl --unix-socket /tmp/toki.sock http://localhost/whoami

import { unlink } from "node:fs/promises";

import { Toki, reply } from "../ts";

const SOCKET_PATH = "/tmp/toki.sock";

const app = new Toki();

app.get("/", () => reply.text("Hello over a Unix socket"));
app.get("/whoami", (req) =>
  reply.json({ transport: "unix", socket: SOCKET_PATH, requestId: req.id }),
);

async function main(): Promise<void> {
  await unlink(SOCKET_PATH).catch(() => undefined); // clear a stale socket from a prior run

  // `port` is required by the type but ignored once unixPath is set.
  const server = await app.listen({ port: 0, unixPath: SOCKET_PATH });
  console.log(`READY unix:${SOCKET_PATH} (resolved port ${server.port})`);

  process.on("SIGINT", () => {
    server.close();
    void unlink(SOCKET_PATH).catch(() => undefined);
    process.exit(0);
  });
}

void main();
