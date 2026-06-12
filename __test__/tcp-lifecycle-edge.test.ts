import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// Lifecycle edge cases on one toki TLS server: stopAccepting + graceful teardown, a setTls
// hot-reload that spares established connections, and the idle-sweep clock being reset by activity.
// One createTcpServer per file (the engine is a singleton); setTls and re-listen are fine on it.
const HOST = "127.0.0.1";
const dir = mkdtempSync(join(tmpdir(), "toki-life-"));
const p = (f: string): string => join(dir, f);
const sh = (a: string[]): void => {
  execFileSync("openssl", a, { stdio: "ignore" });
};

// two distinct self-signed leaves (CN=localhost, SAN 127.0.0.1) — a setTls swap is observable
// because a client trusting cert1 must not trust cert2 and vice versa.
const selfSigned = (keyOut: string, certOut: string): void => {
  sh([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p(keyOut),
    "-out",
    p(certOut),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
};

let cert1: Buffer, key1: Buffer, cert2: Buffer, key2: Buffer;
try {
  selfSigned("k1.pem", "c1.pem");
  selfSigned("k2.pem", "c2.pem");
  cert1 = readFileSync(p("c1.pem"));
  key1 = readFileSync(p("k1.pem"));
  cert2 = readFileSync(p("c2.pem"));
  key2 = readFileSync(p("k2.pem"));
} catch {
  console.log("skipped: openssl not available");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// the two certs must actually differ, else the swap proves nothing.
assert.notEqual(
  new crypto.X509Certificate(cert1).fingerprint256,
  new crypto.X509Certificate(cert2).fingerprint256,
  "cert1 and cert2 are distinct self-signed leaves",
);

// plain echo handler; idleTimeoutMs reaps a connection with no read/write traffic.
const server = createTcpServer(
  (sock: TcpSocket) => {
    sock.on("data", (c) => sock.write(c));
  },
  { tls: { cert: cert1, key: key1 }, idleTimeoutMs: 900 },
);
const { port } = server.listen(0, HOST);
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

// round-trip one byte and confirm the echo; rejects if the socket closes without echoing.
function roundTrips(sock: TcpSocket, tag = "x"): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onData = (c: Buffer): void => {
      if (settled) return;
      if (c.toString() === tag) {
        settled = true;
        sock.off("data", onData);
        sock.off("close", onClose);
        resolve();
      }
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error("closed before echo"));
    };
    sock.on("data", onData);
    sock.on("close", onClose);
    sock.write(tag);
  });
}

function closed(sock: TcpSocket): Promise<string> {
  return new Promise((resolve) => sock.on("close", (r) => resolve(r)));
}

// stopAccepting flips a process-wide native flag with no JS re-enable, so this case runs LAST —
// once it fires, no later test in this file could connect.
test("setTls hot-reload presents cert2 to new handshakes and leaves the established conn on cert1 alone", async () => {
  // A established against cert1.
  const a = await connectTcp(HOST, port, { tls: { servername: "localhost", ca: cert1 } });
  assert.equal(a.authorized, true, "A trusts cert1");
  await roundTrips(a, "1");

  // hot-reload to cert2.
  server.setTls({ cert: cert2, key: key2 });

  // A keeps working across the swap — established connections are not renegotiated.
  await roundTrips(a, "2");

  // a new connection B verifies against cert2 only.
  const b = await connectTcp(HOST, port, { tls: { servername: "localhost", ca: cert2 } });
  assert.equal(b.authorized, true, "B trusts cert2 (the reloaded cert)");
  assert.equal(
    new crypto.X509Certificate(b.peerCertificate()!).fingerprint256,
    new crypto.X509Certificate(cert2).fingerprint256,
    "B was served cert2",
  );
  await roundTrips(b, "3");

  // the swap really happened: a new connection that trusts ONLY cert1 must now fail to verify.
  await assert.rejects(
    connectTcp(HOST, port, { tls: { servername: "localhost", ca: cert1 }, timeoutMs: 3000 }),
    "after the swap, cert1 no longer verifies the server",
  );

  a.destroy();
  b.destroy();

  // restore cert1 so a later re-handshake (none here) and the original CA stay consistent.
  server.setTls({ cert: cert1, key: key1 });
});

test("activity resets the idle clock: a busy connection outlives an idle one", async () => {
  // both established against the current cert (cert1, restored above).
  const idle = await connectTcp(HOST, port, { tls: { servername: "localhost", ca: cert1 } });
  const busy = await connectTcp(HOST, port, { tls: { servername: "localhost", ca: cert1 } });

  let idleClosed = false;
  let busyClosed = false;
  idle.on("close", () => (idleClosed = true));
  busy.on("close", () => (busyClosed = true));

  // keep `busy` active with round-trips well inside the 900ms idle window; `idle` sends nothing.
  let stop = false;
  const ping = async (): Promise<void> => {
    while (!stop && !busyClosed) {
      try {
        await roundTrips(busy, "p");
      } catch {
        break; // socket gone; loop ends
      }
      await new Promise((r) => {
        const t = setTimeout(r, 150);
        t.unref();
      });
    }
  };
  const pinger = ping();

  // wait (event-driven) for the idle connection to be reaped by the sweep.
  await new Promise<void>((resolve) => idle.on("close", () => resolve()));
  stop = true;
  await pinger;

  assert.equal(idleClosed, true, "the idle connection was reaped by the idle sweep");
  assert.equal(busyClosed, false, "the continuously-active connection survived the same window");

  // the busy connection still works after the idle one died — its clock kept getting reset.
  await roundTrips(busy, "q");

  busy.destroy();
});

test("stopAccepting refuses new connects while the live one keeps round-tripping; then a graceful close", async () => {
  const live = await connectTcp(HOST, port, { tls: { servername: "localhost", ca: cert1 } });
  await roundTrips(live, "a"); // established and echoing

  server.stopAccepting();

  // a brand-new TLS connect must fail (the server resets the peer pre-handshake). It surfaces as a
  // connect/handshake rejection — any reason is fine, but it must NOT succeed.
  await assert.rejects(
    connectTcp(HOST, port, { tls: { servername: "localhost", ca: cert1 }, timeoutMs: 3000 }),
    "a connection opened after stopAccepting is refused",
  );

  // the pre-existing connection is untouched and still echoes.
  await roundTrips(live, "b");

  // graceful teardown: end the live socket (server.close() runs in `after`).
  live.end();
  const reason = await closed(live);
  // an end() close can reach the peer as a clean FIN or, on some stacks, a reset — both are fine.
  assert.ok(["normal", "peer-reset"].includes(reason), `live closed cleanly, got ${reason}`);
});
