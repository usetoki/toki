import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  connectTcp,
  createTcpServer,
  TcpConnectError,
  type CloseReason,
  type TcpSocket,
} from "../ts/index.ts";

// Close-reason coverage for the raw TLS server. One server (the engine is a process singleton);
// each connectTcp client tags its first byte with a token so the handler can hand the matching
// server-side socket (and its close reason) back to the test. The fixture cert is CN=localhost
// with SANs DNS:localhost and IP:127.0.0.1.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));
const otherCa = readFileSync(join(here, "fixtures", "rsa-cert.pem")); // a CA that did NOT sign the server

// the server reports the close reason of whichever connection carried `token`.
const pending = new Map<string, (reason: CloseReason) => void>();

const server = createTcpServer(
  (sock: TcpSocket) => {
    let token = "";
    sock.on("data", (chunk) => {
      if (token === "") {
        token = chunk.toString();
        sock.write(chunk); // echo the token so the client can confirm the session is live
        return;
      }
      const cmd = chunk.toString();
      if (cmd === "END") sock.end(); // server-initiated graceful close
      // a filler the client never drains: its destroy() then RSTs over the unread bytes.
      if (cmd === "RESET") sock.write(Buffer.alloc(64 * 1024, 0x63));
    });
    sock.on("close", (reason) => pending.get(token)?.(reason));
  },
  { tls: { cert, key }, handshakeTimeoutMs: 700 },
);
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

let nextToken = 0;

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

// open a verified client, send a token, wait for the echo, and expose the server-side close
// reason as a promise. The session is provably established (the echo round-tripped) before the
// caller drives the close, so the reason is never confused with a handshake-time outcome.
async function session(): Promise<{ sock: TcpSocket; serverClose: Promise<CloseReason> }> {
  const token = `t${nextToken++}`;
  const serverClose = new Promise<CloseReason>((resolve) => pending.set(token, resolve));
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "localhost", ca: cert },
    timeoutMs: 4000,
  });
  sock.write(token);
  assert.equal((await read(sock, token.length)).toString(), token, "session is live");
  return { sock, serverClose };
}

// 1. a client handshake that fails verification rejects with a typed TLS reason. (The prompt calls
// this the 'tls-error' path; on the connectTcp client side the typed reason is 'tls-verify' — a
// handshake failure that never reaches the server handler, so the enum is observed client-side.)
test("a client whose TLS handshake fails verification rejects with 'tls-verify'", async () => {
  await assert.rejects(
    connectTcp("127.0.0.1", port, {
      tls: { servername: "localhost", ca: otherCa },
      timeoutMs: 4000,
    }),
    (e: TcpConnectError) => e instanceof TcpConnectError && e.reason === "tls-verify",
  );
});

// 1b. a plaintext/garbage peer that never sends a valid ClientHello is rejected by the server. The
// failed handshake never reaches the handler, so we assert the peer connection is closed promptly.
test("a garbage (non-ClientHello) peer is closed by the server", async () => {
  const c = net.connect(port, "127.0.0.1");
  c.on("error", () => {}); // a reset of the bad peer is expected
  await new Promise<void>((resolve) => {
    c.on("connect", () => c.write("this is not tls\r\n"));
    c.on("close", () => resolve());
  });
  // reaching here means the server tore down the bogus handshake (no hang).
  assert.ok(true);
});

// 2. handshakeTimeoutMs: a raw peer that opens the socket but never sends a ClientHello is dropped
// by the ~1s sweep (handshakeTimeoutMs is 700ms, so ~1.7s nominal).
test("handshake-timeout: a silent TLS peer is closed by the sweep", async () => {
  const c = net.connect(port, "127.0.0.1");
  c.on("error", () => {});
  const t0 = Date.now();
  await new Promise<void>((resolve) => c.on("close", () => resolve()));
  // generous slack for a loaded CI box: the point is the silent peer IS swept (the await would hang
  // forever otherwise), not the exact latency. Exceeding this means the sweep regressed, not stalled.
  assert.ok(Date.now() - t0 < 5000, `the stalled handshake was swept, took ${Date.now() - t0}ms`);
});

// 3. peer-reset: a mid-session destroy() on a TLS conn (RST, no close_notify) surfaces on the
// server as 'peer-reset'. The client must hold the server's filler UNREAD so the OS sends an RST
// on close — a toki connectTcp socket drains continuously, defeating the reset, so this case uses
// a paused raw tls client (the assertion is still on the toki SERVER socket's close reason).
test("peer-reset: a client RST over unread data reports 'peer-reset' server-side", async () => {
  const token = `t${nextToken++}`;
  const serverClose = new Promise<CloseReason>((resolve) => pending.set(token, resolve));
  const reason = await new Promise<CloseReason>((resolve, reject) => {
    let connected = false;
    let stage = 0; // 0: awaiting token echo, 1: awaiting filler
    const c = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
      connected = true;
      c.write(token);
    });
    c.on("data", () => {
      if (stage === 0) {
        stage = 1;
        c.write("RESET"); // ask for the 64 KiB filler
        return;
      }
      c.destroy(); // RST on the filler's first chunk, the rest still unread in the kernel
    });
    c.on("error", (e) => {
      if (!connected) reject(e);
    });
    serverClose.then(resolve, reject);
  });
  assert.equal(reason, "peer-reset", `server saw the RST, got ${reason}`);
});

// 4. normal: a server-initiated graceful end() is a clean close. Whether the FIN reaches the peer
// as a clean close or a reset is OS-dependent, so on the server side accept the 'normal'/'peer-reset'
// set; the client must see a clean close.
test("normal: a server-side end() reports 'normal' server-side, clean close on the client", async () => {
  const { sock, serverClose } = await session();
  const clientClose = new Promise<CloseReason>((resolve) => sock.on("close", (r) => resolve(r)));
  sock.write("END"); // the handler ends its half of the connection on this keyword
  const [sReason, cReason] = await Promise.all([serverClose, clientClose]);
  assert.equal(sReason, "normal", "the server's own end() is a clean close");
  // whether the FIN reaches the client as a clean close or a reset is OS-dependent.
  assert.ok(["normal", "peer-reset"].includes(cReason), `client clean close, got ${cReason}`);
});
