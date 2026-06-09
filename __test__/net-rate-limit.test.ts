import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { after, describe, test } from "node:test";
import { createTcpServer, createUdpServer } from "../ts/index.ts";

// Native accept/datagram guards, exercised over real loopback sockets. One TCP server
// and one UDP socket for the whole file — the native engine is a singleton per process.

const HOST = "127.0.0.1";
const TCP_MAX = 3;
const UDP_MAX = 4;

let accepted = 0;
const server = createTcpServer(
  (socket) => {
    accepted++;
    socket.write("hello");
  },
  { rateLimit: { max: TCP_MAX, windowMs: 60_000 } },
);
const { port: tcpPort } = server.listen(0, HOST);

let delivered = 0;
const udp = createUdpServer(
  () => {
    delivered++;
  },
  { rateLimit: { max: UDP_MAX, windowMs: 60_000 } },
);
const { port: udpPort } = udp.bind(0, HOST);

after(() => {
  server.close();
  udp.close();
});

// open one client connection; resolve with what happened to it
function connect(): Promise<{ greeted: boolean }> {
  return new Promise((resolve) => {
    const c = net.connect(tcpPort, HOST);
    let greeted = false;
    c.on("data", () => {
      greeted = true;
      c.destroy();
    });
    c.on("error", () => {});
    c.on("close", () => resolve({ greeted }));
  });
}

describe("tcp — native accept guard", () => {
  test("admits up to max accepts per IP and resets the rest", async () => {
    const results: Array<{ greeted: boolean }> = [];
    for (let i = 0; i < TCP_MAX + 3; i++) results.push(await connect());
    const greeted = results.filter((r) => r.greeted).length;
    assert.equal(greeted, TCP_MAX);
    assert.equal(accepted, TCP_MAX); // the handler never saw the rejected ones
    // and the rejected connections were dropped, not served
    for (const r of results.slice(TCP_MAX)) assert.equal(r.greeted, false);
  });
});

describe("udp — native datagram guard", () => {
  test("delivers up to max datagrams per source and drops the rest", async () => {
    const client = dgram.createSocket("udp4");
    for (let i = 0; i < UDP_MAX + 6; i++) {
      await new Promise<void>((resolve, reject) =>
        client.send(Buffer.from(`p${i}`), udpPort, HOST, (err) => (err ? reject(err) : resolve())),
      );
    }
    // loopback delivery is near-instant; give the loop a moment to drain
    await new Promise((r) => setTimeout(r, 150));
    client.close();
    assert.equal(delivered, UDP_MAX);
  });
});
