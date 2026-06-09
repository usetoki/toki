// A secure UDP echo server: every datagram is sealed with AES-256-GCM under a pre-shared
// key. Forged, tampered, truncated, wrong-key, or replayed datagrams are dropped before
// onMessage, so the handler only ever sees genuine plaintext.
// run:  TOKI_PSK=<64 hex chars> node examples/udp-secure.ts
//
// This is authenticated encryption per datagram, NOT DTLS: no handshake, no session, no
// PKI. Both ends just share the 32-byte key.
//
// A client seals its request and opens the reply with the same key and the exported
// primitives:
//
//   import { createSocket } from "node:dgram";
//   import { openDatagram, sealDatagram } from "@usetoki/toki";
//
//   const client = createSocket("udp4");
//   client.on("message", (sealed) => {
//     const plain = openDatagram(key, sealed); // Buffer | null
//     if (plain !== null) console.log("reply:", plain.toString());
//     client.close();
//   });
//   client.send(sealDatagram(key, Buffer.from("ping")), 9101, "127.0.0.1");
import { randomBytes } from "node:crypto";
import { createUdpServer } from "@usetoki/toki";

const PORT = 9101;
const HOST = "127.0.0.1";

// 32-byte AES-256 key, shared with the peers. Supply your own via env (64 hex chars);
// the random fallback only makes sense when the client runs in the same process.
const key = process.env.TOKI_PSK ? Buffer.from(process.env.TOKI_PSK, "hex") : randomBytes(32);
if (key.length !== 32) throw new Error("TOKI_PSK must be 64 hex chars (32 bytes)");

const sock = createUdpServer(
  (msg, rinfo, socket) => {
    // msg is already decrypted + authenticated; a bad datagram never reaches here.
    console.log(`recv ${msg.length}B from ${rinfo.address}:${rinfo.port}`);
    // reply gets sealed automatically on the way out
    socket.send(msg, rinfo.port, rinfo.address);
  },
  {
    secure: {
      key,
      antiReplay: 100_000, // drop repeated datagrams, remembering the last 100k nonces
    },
  },
);

const { port } = sock.bind(PORT, HOST);
console.log(`secure udp echo on ${HOST}:${port} (psk ${key.length}B)`);

// Graceful shutdown: stop receiving and close the socket.
process.on("SIGINT", () => {
  console.log("\nshutting down");
  sock.close();
  process.exit(0);
});
