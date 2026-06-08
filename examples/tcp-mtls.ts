// Mutual TLS over raw TCP. The server asks every client for a certificate and REQUIRES it
// to verify against a CA (requestCert + ca + rejectUnauthorized). A client holding a
// CA-signed cert gets through and the handler sees `socket.authorized === true`; a client
// with no cert is rejected during the handshake and never reaches the handler.
//
// Self-contained: mints a throwaway CA, a server leaf, and a client leaf with openssl, all
// signed by the same CA. TLS 1.3 only. Don't reuse these certs for anything real.
// run: node examples/tcp-mtls.ts
import assert from "node:assert/strict";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTcpServer, type TcpSocket } from "@usetoki/toki";

const HOST = "127.0.0.1";
const dir = mkdtempSync(join(tmpdir(), "toki-mtls-"));
const p = (f: string): string => join(dir, f);
const sh = (args: string[]): void => {
  execFileSync("openssl", args, { stdio: "ignore" });
};

try {
  // A CA we control. The server trusts it to vouch for clients; the client trusts it to
  // vouch for the server. Both leaves below are signed by it.
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
    "/CN=Toki Demo CA",
  ]);
  // Server leaf — CN/SAN localhost so the client can verify the hostname.
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
  // Client leaf — its identity is the CN; the server verifies it chains to our CA.
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("cli-key.pem"),
    "-out",
    p("cli.csr"),
    "-subj",
    "/CN=demo-client",
  ]);
  sh([
    "x509",
    "-req",
    "-in",
    p("cli.csr"),
    "-CA",
    p("ca-cert.pem"),
    "-CAkey",
    p("ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    p("cli-cert.pem"),
  ]);
} catch {
  console.log("skipped: openssl not available to mint demo certificates");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const caCert = readFileSync(p("ca-cert.pem"));
const srvCert = readFileSync(p("srv-cert.pem"));
const srvKey = readFileSync(p("srv-key.pem"));
const cliCert = readFileSync(p("cli-cert.pem"));
const cliKey = readFileSync(p("cli-key.pem"));

// Server-side bookkeeping: how many connections reached the handler, and the authorized
// flag we saw. With rejectUnauthorized, only verified clients ever get here.
let handlerCount = 0;
let lastAuthorized = false;

const server = createTcpServer(
  (socket: TcpSocket) => {
    handlerCount += 1;
    lastAuthorized = socket.authorized;
    socket.on("data", (chunk) => socket.write(chunk)); // echo
  },
  {
    tls: {
      cert: srvCert,
      key: srvKey,
      requestCert: true, // ask the client for a certificate
      ca: caCert, // verify it against our CA
      rejectUnauthorized: true, // and require it — a missing/untrusted cert fails the handshake
    },
  },
);

const { port } = server.listen(0, HOST);

// --- a client WITH a CA-signed cert: handshake completes, echo works, authorized. ---
const echoed = await new Promise<string>((resolve, reject) => {
  const sock = tls.connect(
    { host: HOST, port, ca: caCert, cert: cliCert, key: cliKey, servername: "localhost" },
    () => sock.write("ping"),
  );
  sock.setEncoding("utf8");
  sock.once("data", (d: string) => {
    sock.end();
    resolve(d);
  });
  sock.on("error", reject);
});
assert.equal(echoed, "ping");
assert.equal(lastAuthorized, true);
console.log(
  `authorized client echoed ${JSON.stringify(echoed)} (socket.authorized=${lastAuthorized})`,
);

// --- a client with NO cert: the server rejects it at the handshake. In TLS 1.3 the client
// sends its (empty) certificate in the final flight, so its connect callback can fire before
// the server resets — "rejected" means no echo arrives and the handler never runs. ---
const countBefore = handlerCount;
const rejected = await new Promise<boolean>((resolve) => {
  const sock = tls.connect({ host: HOST, port, ca: caCert, servername: "localhost" }, () =>
    sock.write("ping"),
  );
  let settled = false;
  let gotEcho = false;
  const timer = setTimeout(() => finish(!gotEcho), 500);
  timer.unref();
  function finish(v: boolean): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sock.destroy();
    resolve(v);
  }
  sock.on("data", () => (gotEcho = true));
  sock.on("error", () => finish(true)); // server reset the connection
  sock.on("close", () => finish(!gotEcho)); // closed without ever echoing
});
assert.equal(rejected, true);
assert.equal(handlerCount, countBefore, "the certless client must never reach the handler");
console.log("certless client rejected at the handshake (handler never ran)");

server.close();
rmSync(dir, { recursive: true, force: true });
console.log("ok");
