import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// peerCertificate(): the peer's leaf certificate in DER. On a connectTcp client it's the server's
// certificate; on a server (mutual TLS) it's the client's. The DER must be byte-for-byte the real
// certificate — crypto.X509(pem).raw (OpenSSL) is the reference.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));
const DER = new crypto.X509Certificate(cert).raw; // the fixture certificate in DER

// mTLS-capable, but rejectUnauthorized is off so a client without a cert still connects. The
// handler reports the client's certificate (DER hex, or "none") so the server side can be checked.
const server = createTcpServer(
  (sock) => {
    sock.on("data", () => {
      const pc = sock.peerCertificate();
      sock.write(`${pc ? pc.toString("hex") : "none"}\n`);
    });
  },
  { tls: { cert, key, requestCert: true, ca: cert, rejectUnauthorized: false } },
);
const { port } = server.listen(0, "127.0.0.1");

const plain = net.createServer((s) => {
  s.on("error", () => {});
  s.on("data", () => s.write("hi"));
});
plain.listen(0, "127.0.0.1");
const plainPort = () => (plain.address() as net.AddressInfo).port;

after(() => {
  server.close();
  plain.close();
});

function line(sock: TcpSocket): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      if (buf.includes("\n")) resolve(buf.trim());
    });
  });
}

test("a client sees the server's leaf certificate in DER", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  const pc = sock.peerCertificate();
  assert.ok(pc, "a certificate is present");
  assert.ok(pc.equals(DER), "the DER matches the real server certificate exactly");
  sock.destroy();
});

test("a server without a client cert reports no peer certificate", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  sock.write("go");
  assert.equal(await line(sock), "none", "the server saw no client certificate");
  sock.destroy();
});

test("a server sees the client's leaf certificate in DER (mutual TLS)", async () => {
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "localhost", ca: cert, cert, key },
  });
  sock.write("go");
  assert.equal(await line(sock), DER.toString("hex"), "the server retained the client certificate");
  sock.destroy();
});

test("peerCertificate is undefined on a plaintext connection", async () => {
  const sock = await connectTcp("127.0.0.1", plainPort(), {});
  assert.equal(sock.peerCertificate(), undefined);
  sock.destroy();
});
