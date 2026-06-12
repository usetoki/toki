import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// SNI virtual hosts: the server presents a different certificate per requested host name and the
// handler reads the requested name off socket.servername. The default cert covers anything
// unmatched. All certs are P-256 (the same key algorithm), as the selector requires.
const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, "fixtures", f));
const cert = read("ec-cert.pem"); // default, CN=localhost
const key = read("ec-key.pem");
const vhostCert = read("ec-vhost-cert.pem"); // CN=vhost.local
const vhostKey = read("ec-vhost-key.pem");
const wildCert = read("ec-wild-cert.pem"); // CN=*.wild.local
const wildKey = read("ec-wild-key.pem");

const server = createTcpServer(
  (sock) => {
    sock.write(`${sock.servername ?? "none"}\n`);
  },
  {
    tls: {
      cert,
      key,
      sni: [
        { servername: "vhost.local", cert: vhostCert, key: vhostKey },
        { servername: "*.wild.local", cert: wildCert, key: wildKey },
      ],
    },
  },
);
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

function line(sock: TcpSocket): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      if (buf.includes("\n")) resolve(buf.trim());
    });
  });
}

test("an exact SNI name selects its certificate and is exposed to the server", async () => {
  // the client verifies against the vhost cert — so the server must have presented exactly it.
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "vhost.local", ca: vhostCert },
  });
  assert.equal(sock.authorized, true, "the vhost certificate verified");
  assert.equal(await line(sock), "vhost.local", "the server saw the requested host name");
  sock.destroy();
});

test("a wildcard SNI name selects its certificate", async () => {
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "a.wild.local", ca: wildCert },
  });
  assert.equal(sock.authorized, true, "the wildcard certificate verified for a.wild.local");
  assert.equal(await line(sock), "a.wild.local");
  sock.destroy();
});

test("an unmatched name falls back to the default certificate", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  assert.equal(sock.authorized, true, "the default certificate verified");
  assert.equal(await line(sock), "localhost");
  sock.destroy();
});

test("a Node client gets the per-SNI certificate (interop)", async () => {
  const c = tls.connect({
    port,
    host: "127.0.0.1",
    servername: "vhost.local",
    ca: vhostCert,
    minVersion: "TLSv1.3",
  });
  await new Promise<void>((res, rej) => {
    c.once("secureConnect", res);
    c.once("error", rej);
  });
  assert.equal(c.authorized, true);
  assert.equal(c.getPeerCertificate().subject.CN, "vhost.local", "Node saw the vhost certificate");
  c.destroy();
});

test("servername is undefined on a client connection", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  assert.equal(sock.servername, undefined, "the client side has no requested name");
  sock.destroy();
});
