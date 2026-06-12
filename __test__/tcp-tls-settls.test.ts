import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer } from "../ts/index.ts";

// server.setTls() hot-reloads the TLS configuration: new handshakes get the new certificate while
// the listener keeps running. The two fixtures are distinct certs (CN=localhost vs CN=vhost.local).
const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, "fixtures", f));
const cert = read("ec-cert.pem");
const key = read("ec-key.pem");
const vhostCert = read("ec-vhost-cert.pem");
const vhostKey = read("ec-vhost-key.pem");
const cn = (der: Buffer) => new crypto.X509Certificate(der).subject;

const server = createTcpServer((sock) => sock.write("hi"), { tls: { cert, key } });
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

test("a new certificate set with setTls is presented to later handshakes", async () => {
  // before: the original cert.
  const before = await connectTcp("127.0.0.1", port, {
    tls: { servername: "localhost", ca: cert },
  });
  assert.equal(cn(before.peerCertificate()!), "CN=localhost", "the original certificate");
  before.destroy();

  // hot-reload to a different cert/key.
  server.setTls({ cert: vhostCert, key: vhostKey });

  const after_ = await connectTcp("127.0.0.1", port, {
    tls: { servername: "vhost.local", ca: vhostCert },
  });
  assert.equal(after_.authorized, true, "the new cert verifies against its CA");
  assert.equal(cn(after_.peerCertificate()!), "CN=vhost.local", "the reloaded certificate");
  after_.destroy();
});
