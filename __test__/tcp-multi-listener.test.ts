import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// One createTcpServer can bind several ports with a single handler; a connection is routed by
// its local port (socket.localPort), the way an XMPP server runs c2s and s2s side by side.
const server = createTcpServer((sock: TcpSocket) => {
  const port = sock.localPort;
  sock.on("data", (c) => sock.write(`${port}:${c.toString()}`));
});
const a = server.listen(0, "127.0.0.1");
const b = server.listen(0, "127.0.0.1");
const c = server.listen(0, "127.0.0.1");
after(() => server.close());

function once(s: TcpSocket, ev: "data"): Promise<Buffer> {
  return new Promise((resolve) => {
    const h = (chunk: Buffer) => {
      s.off("data", h as never);
      resolve(chunk);
    };
    s.on("data", h);
  });
}

test("three ports bind to distinct numbers", () => {
  assert.notEqual(a.port, b.port);
  assert.notEqual(b.port, c.port);
  assert.notEqual(a.port, c.port);
  assert.ok(a.port > 0 && b.port > 0 && c.port > 0);
});

test("each listener routes through the same handler, tagged by localPort", async () => {
  for (const { port } of [a, b, c]) {
    const client = await connectTcp("127.0.0.1", port, {});
    // the echo prefix is the server socket's localPort — proof the handler saw the right listener.
    client.write("ping");
    assert.equal((await once(client, "data")).toString(), `${port}:ping`);
    assert.ok(client.localPort > 0, "the client socket has its own ephemeral local port");
    client.destroy();
  }
});

test("a second server cannot take over the process while the first listens", () => {
  const other = createTcpServer(() => {});
  assert.throws(() => other.listen(0, "127.0.0.1"), /already listening/);
});
