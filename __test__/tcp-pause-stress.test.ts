import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { after, test } from "node:test";
import { createTcpServer, type CloseReason, type TcpSocket } from "../ts/index.ts";

// pause()/resume() stress + ordering on a plaintext server. One server, several listeners; the
// handler routes by socket.localPort. Everything is driven by data/drain/end/close events — no
// fixed sleeps wait for a condition; pause/resume interleave via setImmediate.

type StormReport = { bytes: number; hash: string; closeReason: CloseReason };
type IdemReport = { body: string };
type HalfReport = { gotEnd: boolean; closes: number; closeReason: CloseReason };

let onStorm: ((r: StormReport) => void) | undefined;
let onIdem: ((r: IdemReport) => void) | undefined;
let onHalf: ((r: HalfReport) => void) | undefined;

let stormPort = 0;
let idemPort = 0;
let halfPort = 0;

const server = createTcpServer(
  (sock: TcpSocket) => {
    const lp = sock.localPort;
    if (lp === stormPort) return runStorm(sock);
    if (lp === idemPort) return runIdem(sock);
    if (lp === halfPort) return runHalf(sock);
  },
  // half-open so the server stays readable/writable after the peer FINs, letting us resume()
  // a paused socket and watch the end -> close ordering ourselves.
  { allowHalfOpen: true },
);

// Case 1: pause in the data handler, resume on the next tick, while rolling a hash. Asserts the
// server received the exact byte total with no loss/dup/reorder.
function runStorm(sock: TcpSocket): void {
  const hash = createHash("sha256");
  let bytes = 0;
  sock.on("data", (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
    sock.pause();
    setImmediate(() => sock.resume()); // resume off the event loop, not inline
  });
  sock.on("end", () => sock.end());
  sock.on("close", (reason) => {
    onStorm?.({ bytes, hash: hash.digest("hex"), closeReason: reason });
  });
}

// Case 2: pause() twice then a single resume() must still deliver data (idempotent, no stall).
function runIdem(sock: TcpSocket): void {
  const chunks: Buffer[] = [];
  sock.pause();
  sock.pause(); // second pause is a no-op
  sock.on("data", (c) => {
    chunks.push(c);
    if (Buffer.concat(chunks).length >= 5) onIdem?.({ body: Buffer.concat(chunks).toString() });
  });
  // one resume after the peer has already sent; data was buffered while paused.
  setImmediate(() => sock.resume());
}

// Case 3: pause, peer half-closes (end), server resumes, then sees end exactly once and close once.
function runHalf(sock: TcpSocket): void {
  let gotEnd = false;
  let closes = 0;
  let reason: CloseReason = "normal";
  sock.pause();
  sock.on("end", () => {
    gotEnd = true;
    sock.end(); // ack the half-close from our side
  });
  sock.on("close", (r) => {
    closes += 1;
    reason = r;
    // report a tick later so a (buggy) duplicate close would be counted before we assert.
    setImmediate(() => onHalf?.({ gotEnd, closes, closeReason: reason }));
  });
  // resume off-tick; the buffered FIN surfaces as 'end' after we resume.
  setImmediate(() => sock.resume());
}

stormPort = server.listen(0, "127.0.0.1").port;
idemPort = server.listen(0, "127.0.0.1").port;
halfPort = server.listen(0, "127.0.0.1").port;
after(() => server.close());

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
}

test("cycle storm: rapid pause/resume delivers every byte intact, no loss or reorder", async () => {
  const TOTAL = 2 * 1024 * 1024;
  const CHUNK = 16 * 1024;
  // deterministic payload: byte i = i & 0xff. Hash it up front for the expected digest.
  const payload = Buffer.alloc(TOTAL);
  for (let i = 0; i < TOTAL; i++) payload[i] = i & 0xff;
  const expected = createHash("sha256").update(payload).digest("hex");

  const report = new Promise<StormReport>((resolve) => (onStorm = resolve));
  const c = await connect(stormPort);
  c.on("error", () => {}); // a benign reset on teardown is the test's to swallow

  // stream the payload chunk by chunk, honouring backpressure via 'drain'.
  await new Promise<void>((resolve, reject) => {
    let off = 0;
    const pump = (): void => {
      while (off < TOTAL) {
        const end = Math.min(off + CHUNK, TOTAL);
        const ok = c.write(payload.subarray(off, end));
        off = end;
        if (!ok) {
          c.once("drain", pump);
          return;
        }
      }
      c.end();
      resolve();
    };
    c.once("error", reject);
    pump();
  });

  const r = await report;
  assert.equal(r.bytes, TOTAL, "exact byte total accumulated server-side");
  assert.equal(r.hash, expected, "rolling checksum matches: no loss, dup, or reorder");
  assert.ok(["normal", "peer-reset"].includes(r.closeReason), `closed cleanly (${r.closeReason})`);
});

test("pause() is idempotent: two pause() then one resume() still delivers", async () => {
  const report = new Promise<IdemReport>((resolve) => (onIdem = resolve));
  const c = await connect(idemPort);
  c.on("error", () => {});
  c.write("hello"); // buffered while the server is double-paused
  const r = await report;
  assert.equal(r.body, "hello", "data flowed after a single resume despite two pauses");
  c.destroy();
});

test("pause -> peer half-close -> resume: server sees end then close exactly once", async () => {
  const report = new Promise<HalfReport>((resolve) => (onHalf = resolve));
  const c = await connect(halfPort);
  c.on("error", () => {});
  // peer half-closes immediately, while the server is still paused; the FIN is buffered.
  c.end();
  const r = await report;
  assert.equal(r.gotEnd, true, "the server saw the peer's FIN as 'end' after resuming");
  assert.equal(r.closes, 1, "exactly one close event");
  assert.ok(["normal", "peer-reset"].includes(r.closeReason), `closed cleanly (${r.closeReason})`);
});
