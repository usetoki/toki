// A TLS echo server over raw TCP. The handshake terminates in the native engine, so the
// handler only ever sees plaintext; the ciphertext stays on the wire.
// run:  TLS_CERT=cert.pem TLS_KEY=key.pem node examples/tcp-tls.ts
// test: openssl s_client -connect 127.0.0.1:9443 -quiet    then type a line
//
// Make a throwaway self-signed pair first (do NOT use this in production):
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
//     -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
import { readFileSync } from "node:fs";
import { createTcpServer } from "@usetoki/toki";

const PORT = 9443;
const HOST = "127.0.0.1";

// Cert + key come from files the user supplies, named by env (with sane defaults).
const CERT_PATH = process.env.TLS_CERT ?? "cert.pem";
const KEY_PATH = process.env.TLS_KEY ?? "key.pem";

const server = createTcpServer(
  (socket) => {
    const who = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`connect ${who} (handshake done — session established)`);

    // Read decrypted bytes, write plaintext; the engine encrypts both directions.
    socket.on("data", (chunk) => {
      if (!socket.write(chunk)) {
        // backed up: wait for "drain" before writing more (see examples/tcp.ts)
      }
    });

    socket.on("close", () => console.log(`close   ${who}`));
  },
  {
    tls: {
      cert: readFileSync(CERT_PATH), // leaf first, then any intermediates
      key: readFileSync(KEY_PATH),
    },
  },
);

const { port } = server.listen(PORT, HOST);
console.log(`tls echo on ${HOST}:${port} — try:  openssl s_client -connect ${HOST}:${port} -quiet`);

// Graceful shutdown: stop accepting and drop live connections.
process.on("SIGINT", () => {
  console.log("\nshutting down");
  server.close();
  process.exit(0);
});
