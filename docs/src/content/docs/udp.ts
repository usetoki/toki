import type { DocPage } from "../../types";

export const udpPage: DocPage = {
  slug: "udp",
  title: "UDP server",
  description: "Connectionless datagram sockets backed by native libuv — send and receive packets with no handshake.",
  blocks: [
    {
      kind: "paragraph",
      text: "`createUdpServer(handler, options)` binds a UDP socket. UDP is connectionless: there are no connections to track, just datagrams in and out. Each received packet calls your handler with the message and the sender's address. Reach for this when you want low-overhead, fire-and-forget messaging: telemetry, discovery, DNS-style request/response, game state, anything where dropping the odd packet is fine.",
    },
    {
      kind: "code",
      snippet: {
        filename: "echo.ts",
        language: "ts",
        code: `import { createUdpServer } from "@usetoki/toki";

const sock = createUdpServer((msg, rinfo, socket) => {
  console.log("from", rinfo.address, rinfo.port, "->", msg.toString());
  socket.send(msg, rinfo.port, rinfo.address); // echo back to the sender
});

const { port } = sock.bind(0, "127.0.0.1"); // 0 => OS-assigned port
console.log("listening on", port);`,
      },
    },
    {
      kind: "paragraph",
      text: "`bind(port, host?)` starts receiving. Pass `0` to let the OS pick a free port; the chosen one comes back in the return value. `host` defaults to `0.0.0.0`. The handler receives three arguments:",
    },
    {
      kind: "table",
      headers: ["Argument", "Description"],
      rows: [
        ["`msg: Buffer`", "The datagram payload — a copy, safe to retain."],
        ["`rinfo`", "The sender: `rinfo.address` (string) and `rinfo.port` (number)."],
        ["`socket`", "The bound socket, so you can reply without closing over it."],
      ],
    },
    { kind: "heading", id: "send", text: "Sending" },
    {
      kind: "paragraph",
      text: "`socket.send(data, port, address)` sends one datagram. `data` is a `Uint8Array` or a UTF-8 `string`. There is no acknowledgement and no return value; the packet is handed to the network and forgotten.",
    },
    { kind: "heading", id: "request-response", text: "Request / response" },
    {
      kind: "paragraph",
      text: "Parse the incoming datagram, build a reply, and send it straight back to `rinfo`. Each packet stands alone, so there's no buffering to do.",
    },
    {
      kind: "code",
      snippet: {
        filename: "time.ts",
        language: "ts",
        code: `createUdpServer((msg, rinfo, socket) => {
  const query = msg.toString().trim();
  if (query === "TIME") {
    socket.send(new Date().toISOString(), rinfo.port, rinfo.address);
  } else {
    socket.send("ERR unknown", rinfo.port, rinfo.address);
  }
}).bind(9000, "127.0.0.1");`,
      },
    },
    { kind: "heading", id: "fan-out", text: "Sending to many peers" },
    {
      kind: "paragraph",
      text: "One bound socket can send to any number of destinations. Keep a roster of subscribers and push to each. Useful for broadcasting state to a set of known clients.",
    },
    {
      kind: "code",
      snippet: {
        filename: "broadcast.ts",
        language: "ts",
        code: `const peers = new Map<string, { port: number; address: string }>();

const sock = createUdpServer((msg, rinfo) => {
  // any packet registers / refreshes the sender as a subscriber
  peers.set(\`\${rinfo.address}:\${rinfo.port}\`, rinfo);
});
sock.bind(9001, "127.0.0.1");

// later: push an update to everyone we've heard from
function broadcast(update: string) {
  for (const peer of peers.values()) {
    sock.send(update, peer.port, peer.address);
  }
}`,
      },
    },
    { kind: "heading", id: "addressing", text: "IPv4 and IPv6" },
    {
      kind: "paragraph",
      text: "Addresses are IPv4 by default. An address that contains a `:` is treated as IPv6, so you can send to either family without extra configuration.",
    },
    {
      kind: "code",
      snippet: {
        filename: "ipv6.ts",
        language: "ts",
        code: `const sock = createUdpServer(() => {});
sock.bind(9002, "::1"); // bind an IPv6 loopback socket

sock.send("ping", 9100, "::1");        // IPv6 (has a colon)
sock.send("ping", 9100, "192.168.1.5"); // IPv4`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "Empty datagrams are real. A 0-byte packet is delivered to your handler as an empty `Buffer` — it is not silently dropped, so don't treat `msg.length === 0` as \"nothing arrived\" unless your protocol says so.",
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Description"],
      rows: [
        ["`reuseAddr`", "`boolean`", "`false`", "Set `SO_REUSEADDR` so the port can be rebound quickly (and shared across workers)."],
        ["`recvmmsg`", "`boolean`", "`false`", "Batch reads with `recvmmsg` on Linux for higher receive throughput under load."],
        ["`rateLimit`", "`{ max, windowMs }`", "off", "Native per-source datagram limit — see [Rate limiting datagrams](#rate-limit)."],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "One UDP socket per process. The native engine is a singleton, so a second `bind()` throws. Scale across cores by running several processes with `reuseAddr: true`.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "UDP has no delivery guarantee — packets can be lost, duplicated, or arrive out of order. Build any reliability you need (acks, sequence numbers, retries) into your own protocol.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Beware amplification. A spoofed source address can turn a small request into a large reply aimed at a victim. Never send a response much larger than the request to an unverified peer, and rate-limit by source.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "The `Buffer` handed to the handler is a copy of the datagram — it stays valid after the handler returns, so you can queue or store it freely.",
    },
    { kind: "heading", id: "rate-limit", text: "Rate limiting datagrams" },
    {
      kind: "paragraph",
      text: "`rateLimit: { max, windowMs }` caps how many datagrams one source address may deliver per window. An over-limit packet is dropped inside the engine — before any decryption, before the Buffer copy, before the dispatch into JS — and nothing is sent back, since answering an over-limit datagram would hand a spoofing attacker an amplifier.",
    },
    {
      kind: "code",
      snippet: {
        filename: "guarded-udp.ts",
        language: "ts",
        code: `const server = createUdpServer(onMessage, {
  rateLimit: { max: 1000, windowMs: 1_000 }, // 1000 datagrams per source per second
  secure: { key }, // over-limit packets are dropped before any decryption
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Be honest about what this buys you: the packet has already crossed the kernel, so this caps what a source can make your JS thread chew through — abuse control, not a line-rate DDoS shield. Volumetric floods are soaked further upstream. For per-key budgets or shared counters, wrap the handler with `udpRateLimit` from [`@usetoki/toki-ratelimiter`](/docs/plugin-rate-limiter).",
    },
    { kind: "heading", id: "secure", text: "Secure datagrams" },
    {
      kind: "paragraph",
      text: "Pass `secure: { key }` with a 32-byte pre-shared key and every datagram is sealed with AES-256-GCM: confidentiality and integrity per packet. Outgoing datagrams are encrypted in `socket.send`; incoming ones are authenticated and decrypted before your handler runs. A forged, tampered, truncated, or wrong-key datagram fails authentication and is dropped, so `onMessage` only ever sees genuine plaintext.",
    },
    {
      kind: "code",
      snippet: {
        filename: "secure.ts",
        language: "ts",
        code: `import { randomBytes } from "node:crypto";
import { createUdpServer } from "@usetoki/toki";

const key = randomBytes(32); // 32-byte AES-256 key, shared with the peers

const sock = createUdpServer((msg, rinfo, socket) => {
  // msg is already decrypted + authenticated plaintext
  socket.send(msg, rinfo.port, rinfo.address); // reply is sealed on the way out
}, {
  secure: { key, antiReplay: 100_000 }, // antiReplay drops repeated datagrams
});

sock.bind(9100, "127.0.0.1");`,
      },
    },
    {
      kind: "table",
      headers: ["Field", "Type", "Description"],
      rows: [
        ["`key`", "`Uint8Array`", "The shared 32-byte AES-256 key. Both ends must hold the same key."],
        [
          "`antiReplay`",
          "`number`",
          "Optional. Remember this many recent nonces and drop a replayed datagram. Off by default.",
        ],
      ],
    },
    { kind: "heading", id: "primitives", text: "Sealing it yourself" },
    {
      kind: "paragraph",
      text: "The same primitives the server uses are exported, so a client (or any peer) can seal and open datagrams with the shared key. `sealDatagram(key, plaintext)` returns the sealed `Buffer`; `openDatagram(key, sealed)` returns the plaintext `Buffer`, or `null` if it fails authentication. `ReplayWindow` tracks seen nonces if you want replay protection on the client side too.",
    },
    {
      kind: "code",
      snippet: {
        filename: "client.ts",
        language: "ts",
        code: `import { createSocket } from "node:dgram";
import { openDatagram, sealDatagram } from "@usetoki/toki";

const client = createSocket("udp4");

client.on("message", (sealed) => {
  const plain = openDatagram(key, sealed); // Buffer | null
  if (plain === null) return; // not from someone holding the key — drop
  console.log("reply:", plain.toString());
  client.close();
});

const sealed = sealDatagram(key, Buffer.from("ping"));
client.send(sealed, 9100, "127.0.0.1");`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "This is authenticated encryption per datagram, not DTLS. There is no handshake, no session, and no PKI — both ends just share a pre-shared key. `antiReplay` is bounded best-effort: it caps memory, so a captured datagram can eventually age out of the window and replay. Size the window to your threat model.",
    },
    { kind: "heading", id: "noise", text: "Encrypted sessions (Noise)" },
    {
      kind: "paragraph",
      text: "The per-datagram `secure` mode above seals each packet under a shared key. `createSecureUdpServer` + `connectSecureUdp` are a step up: they run a Noise XX handshake (X25519 ECDH derives a fresh per-session AES-256-GCM key, both ends prove their static identity, and the ephemeral keys give forward secrecy), then exchange replay-protected encrypted datagrams over the resulting session. This is the WireGuard-style way to secure UDP: a mutually authenticated session per peer rather than a standing pre-shared key.",
    },
    {
      kind: "paragraph",
      text: "Each peer has a long-term X25519 static identity, a `KeyPair` from `generateKeyPair()` with `{ privateKey, publicKey, publicRaw }`. Persist it; `publicRaw` is the 32-byte public key you hand to the other side out-of-band. After the handshake, each end learns the peer's authenticated static key as `remoteStatic`. Compare it against the key you expected to know who you're really talking to.",
    },
    {
      kind: "code",
      snippet: {
        filename: "noise-server.ts",
        language: "ts",
        code: `import { createSecureUdpServer, generateKeyPair } from "@usetoki/toki";

const serverKey = generateKeyPair(); // persist this; share serverKey.publicRaw with clients

const srv = createSecureUdpServer({
  staticKey: serverKey,
  onSession: (s) => {
    // s.remoteStatic is the peer's authenticated static public key — authorize it here
    console.log("peer", s.remoteStatic.toString("hex"));
  },
  onMessage: (msg, s) => {
    s.send("pong:" + msg.toString()); // encrypted reply on this session
  },
});

const { port } = srv.bind(0, "127.0.0.1"); // one udp socket per process
console.log("listening on", port, "pub", serverKey.publicRaw.toString("hex"));`,
      },
    },
    {
      kind: "paragraph",
      text: "A client runs `connectSecureUdp`, which performs the handshake and resolves a live session. It uses `node:dgram` internally, so it can run in the same process as a server without tripping the native single-socket rule. Authenticate the server by checking `session.remoteStatic` equals the `publicRaw` you trust before you send anything sensitive.",
    },
    {
      kind: "code",
      snippet: {
        filename: "noise-client.ts",
        language: "ts",
        code: `import { connectSecureUdp, generateKeyPair } from "@usetoki/toki";

const clientKey = generateKeyPair();
const session = await connectSecureUdp({ staticKey: clientKey }, port, "127.0.0.1");

// authenticate the server: its static key must be the one you expected
if (!session.remoteStatic.equals(serverKey.publicRaw)) {
  session.close();
  throw new Error("unexpected server identity");
}

session.on("message", (m) => console.log("reply:", m.toString()));
session.send("ping");`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "One handshake buys you three things for the life of the session: mutual authentication (each end proves its static identity), forward secrecy (the per-session key comes from ephemeral DH, so a later key compromise can't decrypt captured traffic), and replay protection on every transport datagram.",
    },
    {
      kind: "heading",
      id: "noise-options",
      text: "Session options",
    },
    {
      kind: "paragraph",
      text: "`createSecureUdpServer(options)`:",
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Description"],
      rows: [
        ["`staticKey`", "`KeyPair`", "—", "The server's long-term X25519 identity. Clients authenticate this key."],
        ["`onSession`", "`(s) => void`", "—", "Optional. Called when a peer finishes the handshake. Inspect `s.remoteStatic` to authorize it."],
        ["`onMessage`", "`(msg, s) => void`", "—", "Called with each decrypted, authenticated datagram and its session. Reply with `s.send(...)`."],
        ["`maxPending`", "`number`", "`1024`", "Cap on half-finished handshakes held at once — bounds half-open handshake DoS."],
        ["`maxSessions`", "`number`", "`16384`", "Cap on established sessions. A peer completing handshakes from many source ports would otherwise grow the table without bound; past this the oldest idle session is evicted."],
        ["`sessionTtlMs`", "`number`", "`120000`", "Drop a peer after this many ms of inactivity."],
      ],
    },
    {
      kind: "paragraph",
      text: "`connectSecureUdp(options, port, host?)`:",
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Description"],
      rows: [
        ["`staticKey`", "`KeyPair`", "—", "The client's X25519 identity. The server authenticates it."],
        ["`retransmitMs`", "`number`", "`250`", "Resend the handshake message this often until it lands — UDP can drop it."],
        ["`timeoutMs`", "`number`", "`5000`", "Give up and reject the promise if the handshake doesn't complete in time."],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "This is NOT DTLS. There is no PKI and no wire interop with other stacks: peers authenticate each other by raw static public key, the way WireGuard does. You must distribute those keys out-of-band and verify `remoteStatic` on both ends. There is also no rekey: a session refuses to send once it would exceed 2^64 datagrams under one key, so start a fresh session for long-lived, very high-volume peers.",
    },
    { kind: "heading", id: "choosing", text: "Choosing a UDP security model" },
    {
      kind: "paragraph",
      text: "Three options, in increasing order of protection. Pick the lightest one that covers your threat model:",
    },
    {
      kind: "table",
      headers: ["Model", "Handshake", "Forward secrecy", "Mutual auth", "Replay protection", "Use it when"],
      rows: [
        [
          "Plaintext — `createUdpServer(handler)`",
          "No",
          "No",
          "No",
          "No",
          "Traffic is already trusted (loopback, private network) or non-sensitive telemetry.",
        ],
        [
          "PSK datagram — `createUdpServer(handler, { secure })`",
          "No",
          "No",
          "No",
          "Optional (`antiReplay`)",
          "Every peer already shares one key and you just need per-packet confidentiality + integrity.",
        ],
        [
          "Noise session — `createSecureUdpServer(...)`",
          "Yes (Noise XX)",
          "Yes",
          "Yes (static keys)",
          "Yes (always)",
          "Peers have their own identities and you want a real authenticated, forward-secret session.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "None of these is DTLS. The PSK mode is per-datagram AEAD with a standing shared key; the Noise mode is a WireGuard-style raw-public-key session. Neither interoperates with a DTLS stack on the wire — both ends must be toki (or speak the same scheme).",
    },
    { kind: "heading", id: "shutdown", text: "Shutting down" },
    {
      kind: "paragraph",
      text: "`sock.close()` stops receiving and closes the socket so the process can exit cleanly.",
    },
    {
      kind: "code",
      snippet: {
        filename: "shutdown.ts",
        language: "ts",
        code: `const sock = createUdpServer(() => {});
sock.bind(9003, "127.0.0.1");

process.on("SIGTERM", () => sock.close());`,
      },
    },
  ],
};
