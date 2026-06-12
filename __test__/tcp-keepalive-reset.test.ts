import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { connectTcp, createTcpServer, type CloseReason, type TcpSocket } from "../ts/index.ts";

// keepAlive on an outbound connectTcp socket, and the plaintext close-reason contract: a plaintext
// read-side end (FIN, or a reset that the OS can't distinguish from one) is a normal half-close.
// The unambiguous peer-reset reason is a TLS-only signal (a truncation without close_notify).
let onServerClose: ((r: CloseReason) => void) | undefined;
const server = createTcpServer((sock: TcpSocket) => {
  sock.on("close", (r) => onServerClose?.(r));
  sock.on("data", (c) => sock.write(c)); // echo
});
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

function once(s: TcpSocket, ev: "data"): Promise<Buffer> {
  return new Promise((resolve) => {
    const h = (c: Buffer): void => {
      s.off(ev, h as never);
      resolve(c);
    };
    s.on(ev, h);
  });
}

test("connectTcp honours keepAlive and still round-trips", async () => {
  const c = await connectTcp("127.0.0.1", port, { keepAlive: true, keepAliveDelaySecs: 30 });
  c.write("ping");
  assert.equal((await once(c, "data")).toString(), "ping");
  c.destroy();
});

test("a plaintext peer close is reported as a normal half-close", async () => {
  const reason = new Promise<CloseReason>((resolve) => {
    onServerClose = resolve;
  });
  const c = await connectTcp("127.0.0.1", port, {});
  c.write("y");
  await once(c, "data");
  c.end(); // FIN
  assert.equal(await reason, "normal", "a graceful close is normal");
  onServerClose = undefined;
});

test("a raw client that resets is still handled cleanly (no hang, defined reason)", async () => {
  const reason = new Promise<CloseReason>((resolve) => {
    onServerClose = resolve;
  });
  const raw = net.connect(port, "127.0.0.1");
  raw.on("error", () => {});
  await new Promise<void>((r) => raw.once("connect", () => r()));
  raw.write("x");
  await new Promise<void>((r) => raw.once("data", () => r()));
  raw.resetAndDestroy(); // RST
  // plaintext can't tell a reset from a FIN portably, so the server reports a normal half-close
  // either way — the point is it closes with a defined reason and never hangs.
  assert.ok(["normal", "peer-reset"].includes(await reason), "closed with a defined reason");
  onServerClose = undefined;
});
