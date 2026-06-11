import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer, TcpConnectError, type TcpSocket } from "../ts/index.ts";

// Outbound connectTcp. One toki TLS echo server in this process (the engine is a
// singleton), plus a plaintext node:net echo server for the plaintext-client path. The TLS
// fixture cert is for CN=localhost with SANs DNS:localhost and IP:127.0.0.1.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));
const otherCa = readFileSync(join(here, "fixtures", "rsa-cert.pem")); // a CA that did NOT sign the server

// echoes data back; a connection that sends "die" is destroyed, "bye" is echoed then ended.
const server = createTcpServer(
  (sock) => {
    sock.on("data", (c) => {
      const s = c.toString();
      if (s === "die") {
        sock.destroy();
        return;
      }
      sock.write(c);
      if (s === "bye") sock.end();
    });
  },
  { tls: { cert, key } },
);
const { port } = server.listen(0, "127.0.0.1");

const plain = net.createServer((s) => {
  s.on("error", () => {}); // a client RST (destroy) is expected; don't let it go uncaught
  s.on("data", (c) => s.write(c));
});
plain.listen(0, "127.0.0.1");
const plainPort = () => (plain.address() as net.AddressInfo).port;

// accepts the TCP connection but never speaks TLS — a TLS connect to it hangs in the handshake,
// so timeoutMs fires deterministically on every platform (no reliance on a blackholed address).
const silent = net.createServer((s) => s.on("error", () => {}));
silent.listen(0, "127.0.0.1");
const silentPort = () => (silent.address() as net.AddressInfo).port;

after(() => {
  server.close();
  plain.close();
  silent.close();
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

function closed(sock: TcpSocket): Promise<string> {
  return new Promise((resolve) => sock.on("close", (reason) => resolve(reason)));
}

test("verifies the server cert against a supplied CA and round-trips data", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  assert.equal(sock.authorized, true, "the chain + host name verified");
  sock.write("hello");
  assert.equal((await read(sock, 5)).toString(), "hello");
  sock.end();
  await closed(sock);
});

test("the servername defaults to the host, verified against the DNS SAN", async () => {
  // no explicit servername: the verify name is the host "localhost", matching DNS:localhost.
  // resolving localhost may yield ::1 first; the server is on 127.0.0.1, so this also exercises
  // the fall-through to the next resolved address.
  const sock = await connectTcp("localhost", port, { tls: { ca: cert }, timeoutMs: 4000 });
  assert.equal(sock.authorized, true);
  sock.write("x");
  assert.equal((await read(sock, 1)).toString(), "x");
  sock.destroy();
});

test("rejectUnauthorized:false connects without verifying (authorized=false)", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { rejectUnauthorized: false } });
  assert.equal(sock.authorized, false);
  sock.write("yo");
  assert.equal((await read(sock, 2)).toString(), "yo");
  sock.destroy();
});

test("a server name that doesn't match the cert rejects with 'tls-verify'", async () => {
  await assert.rejects(
    connectTcp("127.0.0.1", port, {
      tls: { servername: "evil.example", ca: cert },
      timeoutMs: 4000,
    }),
    (e: TcpConnectError) => e instanceof TcpConnectError && e.reason === "tls-verify",
  );
});

test("a CA that didn't sign the server cert rejects with 'tls-verify'", async () => {
  await assert.rejects(
    connectTcp("127.0.0.1", port, {
      tls: { servername: "localhost", ca: otherCa },
      timeoutMs: 4000,
    }),
    (e: TcpConnectError) => e.reason === "tls-verify",
  );
});

test("a large payload round-trips intact over TLS (many records)", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  const payload = Buffer.alloc(256 * 1024, 0x5a);
  sock.write(payload);
  const echo = await read(sock, payload.length);
  assert.equal(echo.length, payload.length);
  assert.ok(echo.equals(payload), "no corruption across the record boundaries");
  sock.destroy();
});

test("client end() flushes a final chunk then half-closes cleanly", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  sock.write("a");
  assert.equal((await read(sock, 1)).toString(), "a");
  sock.end();
  assert.equal(await closed(sock), "normal");
});

test("a server-initiated end() surfaces as a clean close on the client", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  sock.write("bye"); // the server echoes then ends its side
  assert.equal((await read(sock, 3)).toString(), "bye");
  assert.equal(await closed(sock), "normal");
});

test("a server destroy mid-stream surfaces as a close (no hang)", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  sock.write("die");
  const reason = await closed(sock);
  assert.ok(reason === "peer-reset" || reason === "normal", `closed with ${reason}`);
});

test("the connected socket exposes the peer address and port", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  assert.equal(sock.remoteAddress, "127.0.0.1");
  assert.equal(sock.remotePort, port);
  sock.destroy();
});

test("many TLS connections resolve and echo independently", async () => {
  const work = Array.from({ length: 12 }, (_, i) =>
    (async () => {
      const sock = await connectTcp("127.0.0.1", port, {
        tls: { servername: "localhost", ca: cert },
      });
      const tag = `n${i}`;
      sock.write(tag);
      const echo = (await read(sock, tag.length)).toString();
      sock.destroy();
      return echo;
    })(),
  );
  const echoes = await Promise.all(work);
  assert.deepEqual(
    echoes,
    Array.from({ length: 12 }, (_, i) => `n${i}`),
  );
});

// --- plaintext client (against a node:net echo server) ---------------------------------

test("a plaintext connect echoes over a node:net server", async () => {
  const sock = await connectTcp("127.0.0.1", plainPort(), {});
  sock.write("plain");
  assert.equal((await read(sock, 5)).toString(), "plain");
  sock.destroy();
});

test("a hostname is resolved (localhost -> 127.0.0.1) on the plaintext path", async () => {
  const sock = await connectTcp("localhost", plainPort(), { timeoutMs: 4000 });
  sock.write("dns-ok");
  assert.equal((await read(sock, 6)).toString(), "dns-ok");
  sock.destroy();
});

// --- typed connect failures (no server needed) -----------------------------------------

test("a refused connection rejects with 'refused'", async () => {
  await assert.rejects(
    connectTcp("127.0.0.1", 1, { timeoutMs: 4000 }),
    (e: TcpConnectError) => e instanceof TcpConnectError && e.reason === "refused",
  );
});

test("an unresolvable host rejects with 'dns'", async () => {
  await assert.rejects(
    connectTcp("does-not-exist.invalid", 443, { timeoutMs: 4000 }),
    (e: TcpConnectError) => e.reason === "dns",
  );
});

test("a TLS handshake that outruns timeoutMs rejects with 'timeout'", async () => {
  // the silent server completes the TCP connect but never answers the ClientHello, so the
  // handshake stalls and the deadline fires — deterministic on every platform.
  const t0 = Date.now();
  await assert.rejects(
    connectTcp("127.0.0.1", silentPort(), { tls: { rejectUnauthorized: false }, timeoutMs: 300 }),
    (e: TcpConnectError) => e instanceof TcpConnectError && e.reason === "timeout",
  );
  assert.ok(Date.now() - t0 < 3000, "the timeout fired near 300ms, not the OS default");
});

test("a generous timeout does not spuriously fire on a fast connect", async () => {
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "localhost", ca: cert },
    timeoutMs: 5000,
  });
  sock.write("ok");
  assert.equal((await read(sock, 2)).toString(), "ok");
  sock.destroy();
});
