import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// handshakeTimeoutMs closes a TLS connection whose handshake never establishes; idleTimeoutMs
// closes a connection with no read/write activity. Both are enforced by a ~1s sweep, so the tests
// allow a couple of seconds.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));

const server = createTcpServer((sock: TcpSocket) => sock.write("hi"), {
  tls: { cert, key },
  handshakeTimeoutMs: 300,
  idleTimeoutMs: 700,
});
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

test("handshakeTimeoutMs closes a TLS connection that never completes its handshake", async () => {
  // a plaintext peer that opens the socket but never sends a ClientHello.
  const c = net.connect(port, "127.0.0.1");
  c.on("error", () => {});
  const t0 = Date.now();
  await new Promise<void>((resolve) => c.on("close", () => resolve()));
  assert.ok(Date.now() - t0 < 2500, "the server closed the stalled handshake");
});

test("idleTimeoutMs closes an established connection that goes idle", async () => {
  const sock = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  const t0 = Date.now();
  const reason = await new Promise<string>((resolve) => sock.on("close", (r) => resolve(r)));
  // the server drops the idle connection; whether the peer observes the close as a clean FIN
  // ("normal") or a reset ("peer-reset") is OS-dependent (Windows tends to RST an unread close).
  assert.ok(["normal", "peer-reset"].includes(reason), `closed by the idle sweep, got ${reason}`);
  assert.ok(Date.now() - t0 < 2500, "closed within the idle window");
});
