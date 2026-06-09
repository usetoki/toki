// A Noise-XX encrypted UDP echo server, plus an in-process client that handshakes and
// talks to it. Each peer has an X25519 static identity; the handshake derives a per-session
// AES-256-GCM key (forward secrecy), both ends prove their static key (mutual auth), and
// every transport datagram is replay-protected. This is the WireGuard-style way to secure
// UDP, not DTLS: no PKI, no wire interop. Peers authenticate by RAW static public key,
// which you distribute and verify out-of-band (the code checks remoteStatic on both ends).
// run:  node examples/udp-noise.ts
import {
  connectSecureUdp,
  createSecureUdpServer,
  generateKeyPair,
  keyPairFromPrivateRaw,
} from "@usetoki/toki";

const PORT = 9102;
const HOST = "127.0.0.1";

// The server's long-term identity. Persist this and share serverKey.publicRaw with clients
// out-of-band. Supply your own 32-byte private scalar via env (64 hex chars); the random
// fallback only makes sense when the client runs in the same process, as it does here.
const serverKey = process.env.TOKI_SERVER_KEY
  ? keyPairFromPrivateRaw(Buffer.from(process.env.TOKI_SERVER_KEY, "hex"))
  : generateKeyPair();

const srv = createSecureUdpServer({
  staticKey: serverKey,
  onSession: (s) => {
    // s.remoteStatic is the peer's authenticated static public key. authorize it here.
    console.log(`session up: peer ${s.remoteStatic.toString("hex")} @ ${s.address}:${s.port}`);
  },
  onMessage: (msg, s) => {
    // msg is decrypted + authenticated plaintext; the reply is sealed on this session.
    console.log(`recv ${msg.length}B: ${msg.toString()}`);
    s.send("pong:" + msg.toString());
  },
  maxPending: 1024, // bound half-open handshake DoS
  sessionTtlMs: 120_000, // drop idle peers after 2 minutes
});

const { port } = srv.bind(PORT, HOST);

// A real client uses this hex out-of-band to authenticate the server (verify remoteStatic).
console.log(`secure udp (noise) on ${HOST}:${port}`);
console.log(`server pub (share this): ${serverKey.publicRaw.toString("hex")}`);

// Graceful shutdown: stop receiving and close the socket.
process.on("SIGINT", () => {
  console.log("\nshutting down");
  srv.close();
  process.exit(0);
});

// --- in-process client demo: handshake, authenticate the server, ping/pong, then exit. ---
const clientKey = generateKeyPair();
const session = await connectSecureUdp({ staticKey: clientKey }, port, HOST);

// Authenticate the server before trusting the session: its static key must be the one we
// expected. (A real client would compare against a pinned key, not a local one.)
if (!session.remoteStatic.equals(serverKey.publicRaw)) {
  session.close();
  throw new Error("unexpected server identity");
}
console.log("client: server authenticated, sending ping");

session.on("message", (m) => {
  console.log(`client recv: ${m.toString()}`);
  session.close();
  srv.close();
});

session.send("ping");
