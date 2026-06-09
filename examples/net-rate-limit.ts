// Native rate limiting on the raw transports: a per-IP accept guard for TCP and a
// per-source datagram guard for UDP, both enforced inside the engine. An over-limit
// TCP peer is reset before the TLS handshake would even start; an over-limit datagram
// is dropped before it crosses into JS.
// run: node examples/net-rate-limit.ts

import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { createTcpServer, createUdpServer } from "../ts/index.ts";

const HOST = "127.0.0.1";

// --- TCP: at most 2 connections per IP per minute --------------------------------

let accepted = 0;
const server = createTcpServer(
  (socket) => {
    accepted++;
    socket.end("hello\n");
  },
  { rateLimit: { max: 2, windowMs: 60_000 } },
);
const { port } = server.listen(0, HOST);

const connect = (): Promise<boolean> =>
  new Promise((resolve) => {
    const c = net.connect(port, HOST);
    let greeted = false;
    c.on("data", () => (greeted = true));
    c.on("error", () => {});
    c.on("close", () => resolve(greeted));
  });

const tcpResults: boolean[] = [];
for (let i = 0; i < 5; i++) tcpResults.push(await connect());
assert.deepEqual(tcpResults, [true, true, false, false, false]);
assert.equal(accepted, 2); // the handler never saw the rejected three
server.close();

// --- UDP: at most 3 datagrams per source per second ------------------------------

let delivered = 0;
const udp = createUdpServer(
  () => {
    delivered++;
  },
  { rateLimit: { max: 3, windowMs: 1_000 } },
);
const { port: udpPort } = udp.bind(0, HOST);

const client = dgram.createSocket("udp4");
for (let i = 0; i < 8; i++) {
  await new Promise<void>((resolve, reject) =>
    client.send(Buffer.from(`p${i}`), udpPort, HOST, (e) => (e ? reject(e) : resolve())),
  );
}
await new Promise((r) => setTimeout(r, 150)); // let loopback delivery settle
assert.equal(delivered, 3); // the other five were dropped in native code
client.close();
udp.close();

// For per-key budgets, custom limit responses, or counters shared across processes
// (Redis), wrap the handler with @usetoki/toki-ratelimiter's tcpRateLimit/udpRateLimit.

console.log("net-rate-limit ok");
process.exit(0);
