import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// Mutual TLS over connectTcp: the client presents its own cert/key. Its own process (the server is a
// singleton), so this server can require a client cert without disturbing the other suites. The
// self-signed fixture is reused as both the server cert and the CA the two sides trust.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));

// reports back whether it saw a verified client cert, then echoes.
const server = createTcpServer(
  (sock) => {
    sock.on("data", (c) => sock.write(c));
  },
  { tls: { cert, key, requestCert: true, ca: cert, rejectUnauthorized: true } },
);
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

function read(sock: TcpSocket, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    sock.on("data", (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length >= n) resolve(Buffer.concat(chunks));
    });
  });
}

test("the client presents a cert/key and completes mutual TLS", async () => {
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "localhost", ca: cert, cert, key },
    timeoutMs: 4000,
  });
  // the client verified the server; the handshake also carried our client cert to the server.
  assert.equal(sock.authorized, true, "server cert verified by the client");
  sock.write("mtls");
  assert.equal(
    (await read(sock, 4)).toString(),
    "mtls",
    "data flows over the mutually-authed session",
  );
  sock.destroy();
});

test("a client cert without its key fails the connect closed", async () => {
  // a credential half-supplied is a configuration error: fail rather than connect anonymously.
  await assert.rejects(
    connectTcp("127.0.0.1", port, {
      tls: { servername: "localhost", ca: cert, cert },
      timeoutMs: 4000,
    }),
  );
});
