import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// socket.bufferedAmount tracks the send queue: it rises when the peer stops reading and the
// writer keeps producing, then drains once the peer resumes. One server for the whole file —
// the engine is process-global, so a second concurrent listener would clobber the first.

let serverSock: TcpSocket | undefined;
const server = createTcpServer(
  (sock) => {
    serverSock = sock;
    sock.on("data", () => {
      // peer asked us to flood; write until the OS send buffer backs up.
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      for (let i = 0; i < 64; i++) sock.write(chunk);
    });
  },
  { maxWriteQueue: 64 * 1024 * 1024 },
);
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

test("a fresh plaintext connection has a zero bufferedAmount", async () => {
  const client = await connectTcp("127.0.0.1", port, {});
  assert.equal(client.bufferedAmount, 0);
  client.destroy();
});

test("bufferedAmount rises when the peer stops reading and drains when it resumes", async () => {
  const client = await connectTcp("127.0.0.1", port, {});
  client.pause(); // never read, so the server's writes queue up
  client.write("flood");

  for (let i = 0; i < 200 && !(serverSock && serverSock.bufferedAmount > 0); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(
    serverSock!.bufferedAmount > 0,
    `expected a backed-up queue, got ${serverSock?.bufferedAmount}`,
  );

  client.resume(); // drain it
  for (let i = 0; i < 200 && serverSock!.bufferedAmount > 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(serverSock!.bufferedAmount, 0, "queue drained after the peer resumed");
  client.destroy();
});
