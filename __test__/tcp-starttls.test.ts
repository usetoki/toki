import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// STARTTLS: a connection starts plaintext and upgrades to TLS in place via socket.upgradeTLS().
// The server keeps its cert ready (startTls) but doesn't terminate TLS at accept; the handler
// upgrades after the plaintext negotiation. The Node tls.connect({ socket }) path is the interop.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));

const server = createTcpServer(
  (sock: TcpSocket) => {
    let secure = false;
    // 'secure' fires synchronously the moment the upgrade establishes — before any post-upgrade
    // data — so the flag is set in time even when the client's Finished and first app chunk coalesce.
    sock.on("secure", () => (secure = true));
    sock.on("data", (c) => {
      const s = c.toString();
      if (!secure && s === "STARTTLS") {
        sock.write("PROCEED");
        void sock.upgradeTLS().catch(() => {});
        return;
      }
      if (secure) sock.write(`enc:${s}`); // echoed over the now-encrypted channel
    });
  },
  { tls: { cert, key, alpn: ["xmpp-client"] }, startTls: true },
);
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

function once<T = Buffer>(s: TcpSocket | net.Socket | tls.TLSSocket, ev: string): Promise<T> {
  return new Promise((resolve) => {
    const h = (...a: unknown[]) => {
      (s as TcpSocket).off(ev as "data", h as never);
      resolve(a[0] as T);
    };
    (s as TcpSocket).on(ev as "data", h as never);
  });
}

test("a toki client upgrades a plaintext connection to TLS in place", async () => {
  const c = await connectTcp("127.0.0.1", port, {});
  assert.equal(c.alpnProtocol, undefined, "no TLS yet");
  c.write("STARTTLS");
  assert.equal((await once<Buffer>(c, "data")).toString(), "PROCEED");

  await c.upgradeTLS({ servername: "localhost", ca: cert, alpn: ["xmpp-client"] });
  assert.equal(c.authorized, true, "the server cert verified during the upgrade");
  assert.equal(c.alpnProtocol, "xmpp-client", "ALPN negotiated during the upgrade");

  c.write("hello");
  assert.equal((await once<Buffer>(c, "data")).toString(), "enc:hello", "data now flows over TLS");
  c.destroy();
});

test("a Node STARTTLS client (tls.connect over an existing socket) interoperates", async () => {
  const plain = net.connect(port, "127.0.0.1");
  await new Promise<void>((r) => plain.once("connect", () => r()));
  plain.write("STARTTLS");
  await new Promise<void>((r) => plain.once("data", () => r())); // PROCEED
  await new Promise((r) => setTimeout(r, 30)); // let the server settle into TLS read mode

  const secure = tls.connect({
    socket: plain,
    servername: "localhost",
    ca: cert,
    minVersion: "TLSv1.3",
  });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", () => resolve());
    secure.once("error", reject);
  });
  assert.equal(secure.authorized, true, "Node verified the upgraded server cert");
  secure.write("world");
  assert.equal((await once<Buffer>(secure, "data")).toString(), "enc:world");
  secure.destroy();
});
