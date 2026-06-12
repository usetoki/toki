import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { connectTcp, createTcpServer, TcpConnectError, type TcpSocket } from "../ts/index.ts";

// connectTcp edge cases against ONE toki server. The engine is a process singleton, so we bind
// two ports on the same (optional-mTLS) TLS server and route by socket.localPort: an echo port
// (cases 1 + 3) and a flood port whose handler pauses immediately and never reads (case 2).
const dir = mkdtempSync(join(tmpdir(), "toki-connect-edge-"));
const p = (f: string): string => join(dir, f);
const sh = (a: string[]): void => {
  execFileSync("openssl", a, { stdio: "ignore" });
};
const HOST = "127.0.0.1";

let caCert: Buffer;
let srvCert: Buffer, srvKey: Buffer;
let cliCert: Buffer, cliKey: Buffer;

try {
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
    "/CN=Toki Edge CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  const caSign = (csr: string, out: string): void =>
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
      "-copy_extensions",
      "copy",
    ]);

  // server leaf CN=localhost with the loopback SANs so the client can verify it.
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
  caSign("srv.csr", "srv.pem");

  // client leaf for the mTLS-authorized case.
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("cli.key"),
    "-out",
    p("cli.csr"),
    "-subj",
    "/CN=toki-client",
  ]);
  caSign("cli.csr", "cli.pem");

  caCert = readFileSync(p("ca.pem"));
  srvCert = readFileSync(p("srv.pem"));
  srvKey = readFileSync(p("srv.key"));
  cliCert = readFileSync(p("cli.pem"));
  cliKey = readFileSync(p("cli.key"));
} catch {
  console.log("skipped: openssl not available");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// the most recent server-side view of an accepted connection on the echo port (case 3 reads these).
let lastAuthorized: boolean | undefined;
let lastPeerCert: Buffer | undefined;
// the paused server socket on the flood port (case 2): the test resumes it to release backpressure.
// resolved by the handler the instant that connection is accepted, so the resume is deterministic.
let onPausedSock: (sock: TcpSocket) => void;
const pausedSockReady = new Promise<TcpSocket>((resolve) => {
  onPausedSock = resolve;
});

// the whole server terminates TLS (mutual, but optional so authorized can also read false). It binds
// two ports and routes by socket.localPort: an echo port (cases 1 + 3) and a flood port whose handler
// pauses and never reads (case 2). Both ports are TLS — a TLS server runs TLS on every listener.
let echoPort = 0;
let floodPort = 0;

const server = createTcpServer(
  (sock: TcpSocket) => {
    if (sock.localPort === floodPort) {
      // case 2: never read, so a flooding client backs up and eventually sees write() === false.
      sock.pause();
      onPausedSock(sock);
      return;
    }
    // echo port: record the server-side mTLS view, then echo.
    lastAuthorized = sock.authorized;
    lastPeerCert = sock.peerCertificate() ?? undefined;
    sock.on("data", (c) => sock.write(c));
  },
  { tls: { cert: srvCert, key: srvKey, requestCert: true, ca: caCert, rejectUnauthorized: false } },
);
echoPort = server.listen(0, HOST).port;
floodPort = server.listen(0, HOST).port;
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

// resolve once `n` bytes have arrived (across however many data events).
function read(sock: TcpSocket, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    sock.on("data", (c) => {
      chunks.push(c);
      const all = Buffer.concat(chunks);
      if (all.length >= n) resolve(all);
    });
  });
}

function once(sock: TcpSocket, event: "drain" | "end"): Promise<void> {
  return new Promise((resolve) => sock.on(event, () => resolve()));
}

test("destroying many TLS connects mid-handshake leaks nothing — the engine stays healthy", async () => {
  // open and immediately drop 50 TLS connections; each connect either resolves (then we destroy it
  // at once) or rejects (a reset mid-handshake) — both are fine, the point is no fd/handle wedge.
  for (let i = 0; i < 50; i++) {
    try {
      const sock = await connectTcp(HOST, echoPort, {
        tls: { servername: "localhost", ca: caCert, cert: cliCert, key: cliKey },
        timeoutMs: 4000,
      });
      sock.destroy();
    } catch (e) {
      assert.ok(e instanceof TcpConnectError, "a failed connect rejects with a typed error");
    }
  }

  // a final normal connect + round-trip must still work — proves nothing wedged or leaked.
  const sock = await connectTcp(HOST, echoPort, {
    tls: { servername: "localhost", ca: caCert, cert: cliCert, key: cliKey },
    timeoutMs: 4000,
  });
  assert.equal(sock.authorized, true, "client verified the server after the churn");
  sock.write("alive");
  assert.equal((await read(sock, 5)).toString(), "alive", "round-trip still works");
  sock.destroy();
});

test("client backpressure: write() returns false then 'drain' fires after the peer resumes", async () => {
  // the flood-port handler paused itself and never reads, so our writes queue in the OS/engine.
  const client = await connectTcp(HOST, floodPort, {
    tls: { servername: "localhost", ca: caCert, cert: cliCert, key: cliKey },
    timeoutMs: 4000,
  });
  const drained = once(client, "drain");

  // flood until write() reports backpressure (false). A bounded loop keeps it deterministic; the
  // OS socket buffer is finite, so this saturates within a handful of chunks.
  const chunk = Buffer.alloc(256 * 1024, 0x5a);
  let sawFalse = false;
  for (let i = 0; i < 512 && !sawFalse; i++) {
    if (client.write(chunk) === false) sawFalse = true;
  }
  assert.ok(sawFalse, "write() returned false under backpressure");
  assert.ok(client.bufferedAmount > 0, "bytes are queued while the peer is not reading");

  // resuming the server lets the queue flush; the client must then get its 'drain'. Wait for the
  // server to have accepted+paused this connection so the resume is deterministic, not a guess.
  const serverSock = await pausedSockReady;
  serverSock.resume();
  await drained;
  client.destroy();
});

test("server-side mTLS: an authorized client cert sets authorized=true and a peer certificate", async () => {
  const sock = await connectTcp(HOST, echoPort, {
    tls: { servername: "localhost", ca: caCert, cert: cliCert, key: cliKey },
    timeoutMs: 4000,
  });
  // round-trip first so the server handler has certainly run and captured its view.
  sock.write("mtls");
  assert.equal((await read(sock, 4)).toString(), "mtls");
  assert.equal(lastAuthorized, true, "the server verified the client cert against its CA");
  assert.ok(
    lastPeerCert !== undefined && lastPeerCert.length > 0,
    "the server retained the client's leaf certificate",
  );
  sock.destroy();
});
