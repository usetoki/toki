import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { createTcpServer, type TcpSocket } from "../ts/index.ts";

// mTLS chain validation: a cert presented as the issuer of another MUST be a CA (basicConstraints
// cA=TRUE, RFC 5280 §6.1.4). Without that check, a holder of any CA-signed leaf can sign a forged
// identity leaf and have their own non-CA leaf accepted as its issuer — a client-identity spoof.
const dir = mkdtempSync(join(tmpdir(), "toki-chain-"));
const p = (f: string): string => join(dir, f);
const sh = (a: string[]): void => {
  execFileSync("openssl", a, { stdio: "ignore" });
};
const HOST = "127.0.0.1";

let caCert: Buffer;
// concatenated PEM chains the client presents, plus the matching leaf keys.
let attackChain: string, attackKey: Buffer;
let legitChain: string, legitKey: Buffer;

try {
  // root CA (a real CA: cA=TRUE)
  sh([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("ca.key"),
    "-out",
    p("ca.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=Toki Chain CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  const caSign = (csr: string, out: string, ext?: string): void =>
    sh([
      "x509",
      "-req",
      "-in",
      p(csr),
      "-CA",
      p("ca.pem"),
      "-CAkey",
      p("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-out",
      p(out),
      ...(ext ? ["-copy_extensions", "copy"] : []),
    ]);

  // attacker owns a normal CA-signed client leaf (cA=FALSE) — the trust mTLS is meant to scope.
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("alice.key"),
    "-out",
    p("alice.csr"),
    "-subj",
    "/CN=alice",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
  ]);
  caSign("alice.csr", "alice.pem", "copy");
  // attacker signs a forged identity leaf with their own (non-CA) leaf key
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("admin.key"),
    "-out",
    p("admin.csr"),
    "-subj",
    "/CN=admin",
  ]);
  sh([
    "x509",
    "-req",
    "-in",
    p("admin.csr"),
    "-CA",
    p("alice.pem"),
    "-CAkey",
    p("alice.key"),
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    p("admin.pem"),
  ]);

  // a legitimate intermediate (cA=TRUE) signed by the root, signing a real leaf
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("int.key"),
    "-out",
    p("int.csr"),
    "-subj",
    "/CN=Toki Intermediate",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  caSign("int.csr", "int.pem", "copy");
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("bob.key"),
    "-out",
    p("bob.csr"),
    "-subj",
    "/CN=bob",
  ]);
  sh([
    "x509",
    "-req",
    "-in",
    p("bob.csr"),
    "-CA",
    p("int.pem"),
    "-CAkey",
    p("int.key"),
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    p("bob.pem"),
  ]);

  // server leaf (CN localhost) signed by the root, so the client can verify the server too
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("srv.key"),
    "-out",
    p("srv.csr"),
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  caSign("srv.csr", "srv.pem", "copy");

  caCert = readFileSync(p("ca.pem"));
  attackChain = readFileSync(p("admin.pem"), "utf8") + readFileSync(p("alice.pem"), "utf8");
  attackKey = readFileSync(p("admin.key"));
  legitChain = readFileSync(p("bob.pem"), "utf8") + readFileSync(p("int.pem"), "utf8");
  legitKey = readFileSync(p("bob.key"));
} catch {
  console.log("skipped: openssl not available");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

let lastAuthorizedCN = "";
let handlerRuns = 0;
const server = createTcpServer(
  (sock: TcpSocket) => {
    handlerRuns += 1;
    const der = sock.peerCertificate();
    lastAuthorizedCN = der ? `auth=${sock.authorized}` : "no-cert";
    sock.on("data", (c) => sock.write(c));
  },
  {
    tls: {
      cert: readFileSync(p("srv.pem")),
      key: readFileSync(p("srv.key")),
      requestCert: true,
      ca: caCert,
      rejectUnauthorized: true,
    },
  },
);
const { port } = server.listen(0, HOST);
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

// "accepted" means the server's handler ran and echoed — in TLS 1.3 the client cert is in the
// final flight, so a client secureConnect can fire just before the server resets a rejected peer.
// We probe with a byte and treat an echo as acceptance, an error/close-without-echo as rejection.
function probe(chain: string, key: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    let echoed = false;
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    const sock = tls.connect(
      {
        host: HOST,
        port,
        ca: caCert,
        cert: chain,
        key,
        servername: "localhost",
        minVersion: "TLSv1.3",
      },
      () => sock.write("ping"),
    );
    const t = setTimeout(() => done(echoed), 500);
    t.unref();
    sock.on("data", () => {
      echoed = true;
      done(true);
    });
    sock.on("error", () => done(echoed));
    sock.on("close", () => done(echoed));
  });
}

test("a forged [admin <- alice] chain is rejected — a non-CA leaf cannot act as an issuer", async () => {
  const runsBefore = handlerRuns;
  const accepted = await probe(attackChain, attackKey);
  assert.equal(
    accepted,
    false,
    "the handshake must fail: alice (cA=FALSE) is not a valid issuer of admin",
  );
  assert.equal(handlerRuns, runsBefore, "the spoofed client never reaches the handler");
});

test("a legitimate [bob <- intermediate] chain is accepted", async () => {
  const accepted = await probe(legitChain, legitKey);
  assert.equal(accepted, true, "a real CA-signed intermediate is a valid issuer");
  assert.equal(lastAuthorizedCN, "auth=true", "the client authorized through the intermediate");
});
