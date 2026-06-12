import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer, TcpConnectError, type TcpSocket } from "../ts/index.ts";

// ALPN on the raw TLS socket: the server offers a list, the client offers a list, and both read
// the negotiated protocol off socket.alpnProtocol. Server preference wins. A client that offers a
// protocol the server doesn't share is failed per RFC 7301 (the server has an ALPN list). Node's
// OpenSSL-backed tls is the interop reference.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));

// the server offers two protocols in preference order and reports what it negotiated.
const server = createTcpServer(
  (sock) => {
    sock.write(`${sock.alpnProtocol ?? "none"}\n`);
  },
  { tls: { cert, key, alpn: ["h2", "http/1.1"] } },
);
const { port } = server.listen(0, "127.0.0.1");

// a Node tls server (ALPN) for the toki-client direction.
const nodeTls = tls.createServer({ cert, key, ALPNProtocols: ["xmpp-server", "h2"] }, (s) =>
  s.resume(),
);
nodeTls.listen(0, "127.0.0.1");
const nodeTlsPort = () => (nodeTls.address() as net.AddressInfo).port;

const plain = net.createServer((s) => s.on("error", () => {}));
plain.listen(0, "127.0.0.1");
const plainPort = () => (plain.address() as net.AddressInfo).port;

after(() => {
  server.close();
  nodeTls.close();
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

test("client and server negotiate a shared protocol, both sides agree", async () => {
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "localhost", ca: cert, alpn: ["http/1.1"] },
  });
  assert.equal(sock.alpnProtocol, "http/1.1");
  assert.equal(await line(sock), "http/1.1", "the server negotiated the same protocol");
  sock.destroy();
});

test("the server's preference order wins over the client's", async () => {
  // client lists http/1.1 first, but the server prefers h2 → h2 is chosen.
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "localhost", ca: cert, alpn: ["http/1.1", "h2"] },
  });
  assert.equal(sock.alpnProtocol, "h2");
  sock.destroy();
});

test("a Node client negotiates the same protocol against the toki server", async () => {
  const c = tls.connect({
    port,
    host: "127.0.0.1",
    servername: "localhost",
    ca: cert,
    minVersion: "TLSv1.3",
    ALPNProtocols: ["http/1.1"],
  });
  await new Promise<void>((res, rej) => {
    c.once("secureConnect", res);
    c.once("error", rej);
  });
  assert.equal(c.alpnProtocol, "http/1.1");
  c.destroy();
});

test("a toki client negotiates the same protocol against a Node server", async () => {
  const sock = await connectTcp("127.0.0.1", nodeTlsPort(), {
    tls: { servername: "localhost", ca: cert, alpn: ["h2", "http/1.1"] },
  });
  assert.equal(sock.alpnProtocol, "h2");
  sock.destroy();
});

test("a client that offers no ALPN connects, with no protocol negotiated", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  assert.equal(sock.alpnProtocol, undefined, "no ALPN offered, none negotiated");
  assert.equal(await line(sock), "none");
  sock.destroy();
});

test("no shared protocol fails the connect (RFC 7301)", async () => {
  await assert.rejects(
    connectTcp("127.0.0.1", port, {
      tls: { servername: "localhost", ca: cert, alpn: ["nope"] },
      timeoutMs: 4000,
    }),
    (e: TcpConnectError) => e instanceof TcpConnectError,
  );
});

test("alpnProtocol is undefined on a plaintext connection", async () => {
  const sock = await connectTcp("127.0.0.1", plainPort(), {});
  assert.equal(sock.alpnProtocol, undefined);
  sock.destroy();
});
