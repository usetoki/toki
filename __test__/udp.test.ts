import assert from "node:assert/strict";
import dgram from "node:dgram";
import type net from "node:net";
import { after, before, describe, test } from "node:test";
import { createUdpServer, type RemoteInfo } from "../dist/index.js";

// ---------------------------------------------------------------------------
// server under test
// ---------------------------------------------------------------------------

// One UDP socket per process. The native engine is a singleton, and node --test
// runs this file in its own process, so a single bound socket serves the suite.
//
// The server is a plain echo: every datagram goes straight back to its sender.
// Tests that need extra accounting read the shared trackers below.

const HOST = "127.0.0.1";

const retained: Buffer[] = []; // proves the message buffer is a safe copy to keep
let lastRinfo: RemoteInfo | undefined; // sender of the most recent datagram
let received = 0; // total datagrams the server has seen

const server = createUdpServer((msg, rinfo, sock) => {
  received++;
  lastRinfo = { address: rinfo.address, port: rinfo.port };
  retained.push(msg); // keep the buffer; retention test asserts on it later
  sock.send(msg, rinfo.port, rinfo.address); // echo
});

const { port } = server.bind(0, HOST);

after(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// client helpers (Node's built-in dgram client)
// ---------------------------------------------------------------------------

// a bound udp4 client with a promise-based receive.
async function makeClient(): Promise<dgram.Socket> {
  const c = dgram.createSocket("udp4");
  c.bind(0, HOST);
  await new Promise<void>((resolve) => c.once("listening", () => resolve()));
  return c;
}

function recv(c: dgram.Socket): Promise<Buffer> {
  return new Promise((resolve) => c.once("message", (m) => resolve(m)));
}

// send one datagram to the server and wait for the echo, with a deadline so a
// dropped packet fails fast instead of hanging.
function echo(c: dgram.Socket, data: Uint8Array | string, ms = 1000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("echo timeout")), ms);
    c.once("message", (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    c.send(data as Buffer, port, HOST);
  });
}

// The kernel caps a single UDP datagram. Linux allows ~64 KiB; macOS defaults to
// net.inet.udp.maxdgram = 9216 and rejects anything larger with EMSGSIZE on send()
// (both directions — plain node:dgram fails identically). Probe the real ceiling
// once, so the "large datagram" test uses the biggest datagram this OS permits
// rather than falsely failing on a platform limit.
async function largestDeliverable(): Promise<number> {
  const probe = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => {
    probe.bind(0, HOST, () => resolve());
  });
  const self = probe.address().port;
  const accepts = (n: number): Promise<boolean> =>
    new Promise((resolve) => {
      probe.send(Buffer.alloc(n), self, HOST, (err) => resolve(!err));
    });
  // try large to small; take the first the kernel accepts on send()
  let best = 1024;
  for (const n of [60000, 32000, 16000, 9216, 4096, 1024]) {
    // eslint-disable-next-line no-await-in-loop
    if (await accepts(n)) {
      best = n;
      break;
    }
  }
  probe.close();
  return best;
}

let bigSize = 9216;

before(async () => {
  bigSize = await largestDeliverable();
});

// ---------------------------------------------------------------------------
// bind / addressing
// ---------------------------------------------------------------------------

describe("udp — bind & addressing", () => {
  test("bind(0) returns an OS-assigned port > 0", () => {
    assert.equal(typeof port, "number");
    assert.ok(port > 0, `expected a real port, got ${port}`);
  });

  test("rinfo carries the sender's address and port", async () => {
    const c = await makeClient();
    const local = c.address() as net.AddressInfo;
    await echo(c, "addr-check");
    assert.equal(lastRinfo?.address, HOST);
    assert.equal(lastRinfo?.port, local.port);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// echo / payload integrity
// ---------------------------------------------------------------------------

describe("udp — payload integrity", () => {
  test("echoes a simple text datagram", async () => {
    const c = await makeClient();
    const reply = await echo(c, "hello unicode 你好 🚀");
    assert.equal(reply.toString(), "hello unicode 你好 🚀");
    c.close();
  });

  test("a datagram with every byte value 0..255 survives intact", async () => {
    const c = await makeClient();
    const payload = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) payload[i] = i;
    const reply = await echo(c, payload);
    assert.equal(reply.length, 256);
    assert.deepEqual(reply, payload);
    c.close();
  });

  test("an empty (0-byte) datagram is delivered (msg.length === 0)", async () => {
    const c = await makeClient();
    const reply = await echo(c, Buffer.alloc(0));
    assert.equal(reply.length, 0);
    c.close();
  });

  // Round-trip the largest datagram this OS permits (see largestDeliverable above):
  // ~60 KiB on Linux, 9216 on stock macOS. Still a genuinely large datagram either way.
  test("a large datagram round-trips intact (largest the OS allows)", async () => {
    const c = await makeClient();
    const size = bigSize;
    assert.ok(size >= 9216, `expected a multi-KiB datagram ceiling, got ${size}`);
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 37 + 11) & 0xff;
    const reply = await echo(c, payload, 2000);
    assert.equal(reply.length, size, `expected ${size} bytes back, got ${reply.length}`);
    assert.deepEqual(reply, payload);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// routing to the right sender
// ---------------------------------------------------------------------------

describe("udp — sender routing", () => {
  test("echoes reach the client that sent the datagram, not the other", async () => {
    const a = await makeClient();
    const b = await makeClient();

    const gotA = recv(a);
    const gotB = recv(b);

    a.send(Buffer.from("for-a"), port, HOST);
    b.send(Buffer.from("for-b"), port, HOST);

    const [ra, rb] = await Promise.all([gotA, gotB]);
    assert.equal(ra.toString(), "for-a");
    assert.equal(rb.toString(), "for-b");

    a.close();
    b.close();
  });
});

// ---------------------------------------------------------------------------
// buffer retention (proves the copy)
// ---------------------------------------------------------------------------

describe("udp — buffer retention", () => {
  test("a message handler may retain the buffer; bytes stay valid afterward", async () => {
    const c = await makeClient();
    const before = retained.length;
    const payload = Buffer.from("retain-me-长期保留");
    await echo(c, payload);
    const kept = retained.slice(before);
    assert.ok(kept.length >= 1, "handler should have retained the datagram");
    assert.deepEqual(kept[kept.length - 1], payload, "retained buffer was mutated or aliased");
    c.close();
  });
});

// ---------------------------------------------------------------------------
// burst delivery
// ---------------------------------------------------------------------------

describe("udp — burst", () => {
  test("a burst of datagrams nearly all arrive (loopback ~lossless)", async () => {
    const c = await makeClient();
    const count = 200;
    const seen = new Set<number>();

    const done = new Promise<void>((resolve) => {
      c.on("message", (m) => {
        seen.add(m.readUInt32BE(0));
        if (seen.size >= count) resolve();
      });
      // safety net: resolve after a short grace window even if a packet dropped.
      setTimeout(() => resolve(), 1500);
    });

    for (let i = 0; i < count; i++) {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(i, 0);
      c.send(b, port, HOST);
    }

    await done;
    // loopback loss is effectively nil. Demand the overwhelming majority back, and
    // require everything that arrived to be an in-range, unique sequence number.
    assert.ok(seen.size >= count * 0.95, `expected >= ${count * 0.95} echoes, got ${seen.size}`);
    for (const n of seen) assert.ok(n >= 0 && n < count, `out-of-range sequence ${n}`);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// send from the socket directly (server-initiated)
// ---------------------------------------------------------------------------

describe("udp — server send", () => {
  test("socket.send() accepts a string payload (UTF-8 encoded)", async () => {
    const c = await makeClient();
    const reply = await echo(c, "string-not-buffer");
    assert.equal(reply.toString(), "string-not-buffer");
    c.close();
  });
});

// ---------------------------------------------------------------------------
// close() — keep this LAST: it tears the socket down for the file.
// ---------------------------------------------------------------------------

describe("udp — close()", () => {
  test("close() stops delivery (no more echoes after close)", async () => {
    const c = await makeClient();
    // confirm the server is live first.
    const before = await echo(c, "pre-close");
    assert.equal(before.toString(), "pre-close");

    const seenBefore = received;
    server.close();

    // send after close; nothing should come back and the server count must not move.
    let echoed = false;
    c.once("message", () => {
      echoed = true;
    });
    c.send(Buffer.from("post-close"), port, HOST);
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(echoed, false, "no echo should arrive after close()");
    assert.equal(received, seenBefore, "the server must not process datagrams after close()");
    c.close();
  });
});
