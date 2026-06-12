// A TLS peer the way an XMPP server uses one: a single toki server bound to two ports — c2s
// (client-to-server) and s2s (server-to-server) — that both start in plaintext and upgrade to
// TLS 1.3 in place (STARTTLS). One handler serves both, routing by socket.localPort. The c2s
// peer upgrades anonymously; the s2s peer presents a certificate (mutual TLS). After each
// upgrade both ends derive the same exporter keying material (RFC 9266 channel binding) and
// the client reads back the server's certificate. Every party here is toki — the server and
// both dialled-out clients (connectTcp) — so this is the whole peer story end to end.
//
// Self-contained: mints a throwaway CA + a server leaf + an s2s client leaf with openssl.
// TLS 1.3 only. Don't reuse these certs for anything real.
// run: node examples/tcp-tls-peer.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectTcp, createTcpServer, type TcpSocket } from "@usetoki/toki";

const HOST = "127.0.0.1";
const dir = mkdtempSync(join(tmpdir(), "toki-peer-"));
const p = (f: string): string => join(dir, f);
const sh = (args: string[]): void => {
  execFileSync("openssl", args, { stdio: "ignore" });
};

try {
  sh([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("ca-key.pem"),
    "-out",
    p("ca-cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=Tokira Demo CA",
  ]);
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("srv-key.pem"),
    "-out",
    p("srv.csr"),
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  sh([
    "x509",
    "-req",
    "-in",
    p("srv.csr"),
    "-CA",
    p("ca-cert.pem"),
    "-CAkey",
    p("ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "1",
    "-copy_extensions",
    "copy",
    "-out",
    p("srv-cert.pem"),
  ]);
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("peer-key.pem"),
    "-out",
    p("peer.csr"),
    "-subj",
    "/CN=peer.example",
  ]);
  sh([
    "x509",
    "-req",
    "-in",
    p("peer.csr"),
    "-CA",
    p("ca-cert.pem"),
    "-CAkey",
    p("ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    p("peer-cert.pem"),
  ]);
  // a second server leaf (same CA, same name, fresh key) for the setTls hot-reload below.
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("srv2-key.pem"),
    "-out",
    p("srv2.csr"),
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  sh([
    "x509",
    "-req",
    "-in",
    p("srv2.csr"),
    "-CA",
    p("ca-cert.pem"),
    "-CAkey",
    p("ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "1",
    "-copy_extensions",
    "copy",
    "-out",
    p("srv2-cert.pem"),
  ]);
  // an SNI virtual-host leaf (same RSA algo as the default) for a different host name.
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("vhost-key.pem"),
    "-out",
    p("vhost.csr"),
    "-subj",
    "/CN=vhost.localhost",
    "-addext",
    "subjectAltName=DNS:vhost.localhost",
  ]);
  sh([
    "x509",
    "-req",
    "-in",
    p("vhost.csr"),
    "-CA",
    p("ca-cert.pem"),
    "-CAkey",
    p("ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "1",
    "-copy_extensions",
    "copy",
    "-out",
    p("vhost-cert.pem"),
  ]);
} catch {
  console.log("skipped: openssl not available to mint demo certificates");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const caCert = readFileSync(p("ca-cert.pem"));
const srvCert = readFileSync(p("srv-cert.pem"));
const srvKey = readFileSync(p("srv-key.pem"));
const peerCert = readFileSync(p("peer-cert.pem"));
const peerKey = readFileSync(p("peer-key.pem"));

const BINDING = "EXPORTER-tokira-channel-binding";

// what the server learned about each upgraded connection, keyed by role (c2s / s2s).
const seen = new Map<string, { authorized: boolean; exporter: string }>();
let lastServername: string | undefined;
// every close reason the server observed, so a graceful shutdown can be logged.
const closeReasons: string[] = [];

// One server, two listeners. startTls keeps the certificate ready but starts every connection
// in plaintext; requestCert + ca turn on mutual TLS without rejectUnauthorized, so a peer that
// presents no certificate is still allowed (authorized stays false). alpn is offered on upgrade.
const server = createTcpServer(
  (sock: TcpSocket) => {
    const role = sock.localPort === c2s.port ? "c2s" : "s2s";
    let secure = false;
    sock.on("close", (reason) => closeReasons.push(reason));
    sock.on("secure", () => {
      secure = true;
      lastServername = sock.servername;
      const ekm = sock.exportKeyingMaterial(32, BINDING);
      seen.set(role, { authorized: sock.authorized, exporter: ekm!.toString("hex") });
    });
    sock.on("data", (chunk) => {
      const s = chunk.toString();
      if (!secure) {
        if (s === "STARTTLS") {
          sock.write("PROCEED");
          void sock.upgradeTLS().catch(() => {});
        }
        return;
      }
      if (s === "FLOOD") {
        // a slow consumer: stop reading, let the peer's writes back up, then resume.
        sock.pause();
        setImmediate(() => sock.resume().write(`${role}:drained`));
        return;
      }
      sock.write(`${role}:${s}`); // echoed over the now-encrypted channel, tagged by listener
    });
  },
  {
    startTls: true,
    tls: {
      cert: srvCert,
      key: srvKey,
      requestCert: true,
      ca: caCert,
      alpn: ["xmpp-server"],
      sni: [
        {
          servername: "vhost.localhost",
          cert: readFileSync(p("vhost-cert.pem")),
          key: readFileSync(p("vhost-key.pem")),
        },
      ],
    },
  },
);
const c2s = server.listen(0, HOST); // pretend :5222
const s2s = server.listen(0, HOST); // pretend :5269
assert.notEqual(c2s.port, s2s.port);

function once(s: TcpSocket, ev: "data"): Promise<Buffer> {
  return new Promise((resolve) => {
    const h = (chunk: Buffer): void => {
      s.off(ev, h as never);
      resolve(chunk);
    };
    s.on(ev, h);
  });
}

// dial a port in plaintext, do the STARTTLS dance, then upgrade with the given options.
async function startTlsPeer(
  port: number,
  opts: Parameters<TcpSocket["upgradeTLS"]>[0],
): Promise<TcpSocket> {
  const c = await connectTcp(HOST, port, {});
  c.write("STARTTLS");
  assert.equal((await once(c, "data")).toString(), "PROCEED");
  await c.upgradeTLS(opts);
  return c;
}

// --- c2s: an anonymous client. It verifies the server cert against our CA and negotiates ALPN,
// but presents no certificate of its own, so the server sees authorized === false. ---
const client = await startTlsPeer(c2s.port, {
  servername: "localhost",
  ca: caCert,
  alpn: ["xmpp-server"],
});
assert.equal(client.alpnProtocol, "xmpp-server", "ALPN negotiated during the upgrade");
client.write("hello");
assert.equal((await once(client, "data")).toString(), "c2s:hello", "routed to the c2s listener");
assert.equal(seen.get("c2s")!.authorized, false, "anonymous c2s client is not authorized");
// both ends derive identical channel-binding material from the same session (RFC 9266).
const clientEkm = client.exportKeyingMaterial(32, BINDING)!.toString("hex");
assert.equal(clientEkm, seen.get("c2s")!.exporter, "exporter channel binding matches on both ends");
client.destroy();
console.log(
  `c2s upgraded: alpn=${client.alpnProtocol}, channel binding ${clientEkm.slice(0, 16)}… agreed`,
);

// --- s2s: a peer server that presents its own certificate. The server verifies it against the
// CA, so authorized === true, and the client reads back the server's leaf certificate. ---
const peer = await startTlsPeer(s2s.port, {
  servername: "localhost",
  ca: caCert,
  cert: peerCert,
  key: peerKey,
  alpn: ["xmpp-server"],
});
peer.write("dialback");
assert.equal((await once(peer, "data")).toString(), "s2s:dialback", "routed to the s2s listener");
assert.equal(seen.get("s2s")!.authorized, true, "s2s peer presented a CA-signed certificate");
const leaf = peer.peerCertificate();
assert.ok(leaf && leaf.length > 0, "the client read back the server's leaf certificate (DER)");
peer.destroy();
console.log(
  `s2s upgraded: mutual TLS authorized=${seen.get("s2s")!.authorized}, peer cert ${leaf!.length} bytes`,
);

// --- virtual hosts: a client requesting a different SNI name gets that host's certificate, and
// the server reads back the requested name. The default cert still covers the c2s/s2s upgrades. ---
const vhost = await startTlsPeer(c2s.port, { servername: "vhost.localhost", ca: caCert });
vhost.write("hi");
assert.equal((await once(vhost, "data")).toString(), "c2s:hi"); // a round-trip: the server's 'secure' ran
assert.equal(lastServername, "vhost.localhost", "the server saw the requested SNI host");
vhost.destroy();
console.log(`SNI: served the vhost.localhost certificate, server saw servername=${lastServername}`);

// --- read flow control: a slow consumer pauses, the writer's bytes back up, then it drains. ---
const slow = await startTlsPeer(c2s.port, { servername: "localhost", ca: caCert });
slow.write("FLOOD");
assert.equal((await once(slow, "data")).toString(), "c2s:drained", "the paused reader resumed");
console.log("backpressure: a paused handler resumed and drained");

// --- certificate hot-reload: swap the server cert mid-run; established sessions are untouched,
// new handshakes use the new chain. The held `slow` connection keeps working across the swap. ---
const beforeSwap = slow.peerCertificate()!.toString("hex");
server.setTls({ cert: readFileSync(p("srv2-cert.pem")), key: readFileSync(p("srv2-key.pem")) });
slow.write("ping");
assert.equal(
  (await once(slow, "data")).toString(),
  "c2s:ping",
  "the pre-swap session is unaffected",
);
const afterSwap = await startTlsPeer(c2s.port, { servername: "localhost", ca: caCert });
assert.notEqual(
  afterSwap.peerCertificate()!.toString("hex"),
  beforeSwap,
  "a new handshake gets the swapped certificate",
);
console.log("setTls: certificate hot-reloaded; old session kept, new handshake took the new cert");

// --- graceful shutdown: stop accepting, finish the live connections, then close. New dials are
// refused once stopAccepting has run; the connections we end report a clean close reason. ---
server.stopAccepting();
// a new dial is reset at accept: connectTcp may resolve on the TCP connect, but the connection
// is torn down immediately rather than served, so it either rejects or closes on its own at once.
const late = await connectTcp(HOST, c2s.port, {}).catch(() => null);
let refused = late === null;
if (late) {
  refused = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 250);
    t.unref();
    late.on("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  late.destroy();
}
assert.ok(refused, "stopAccepting refused a new connection");
slow.end();
afterSwap.end();
await new Promise((r) => setImmediate(r));
console.log(
  `shutdown: stopAccepting refused new dials; close reasons seen: ${closeReasons.join(", ")}`,
);

server.close();
rmSync(dir, { recursive: true, force: true });
console.log("ok");
