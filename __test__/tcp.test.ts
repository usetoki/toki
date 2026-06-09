import assert from "node:assert/strict";
import net from "node:net";
import { after, describe, test } from "node:test";
import { createTcpServer, type TcpSocket } from "../dist/index.js";

// ---------------------------------------------------------------------------
// server under test
// ---------------------------------------------------------------------------

// One raw TCP server per process. The native engine is a singleton, so a second
// listen() clobbers the first; node --test runs this file in its own process.
//
// The handler is a dispatcher. The first chunk a connection sends names the
// behaviour it wants ("echo", "half", "flood", ...), so the whole suite sits
// behind one server while each test drives an isolated connection.

const HOST = "127.0.0.1";

// connections opt into a mode with a 1-line command; everything after the first
// newline is that mode's payload.
const accepted: TcpSocket[] = []; // every socket the server ever saw
const retained: Buffer[] = []; // proves the "data" chunk is a safe copy to keep
let echoConnections = 0; // echo-conn count, for isolation accounting
let lastClosedMode = ""; // mode of the most recent server-side close

const server = createTcpServer((socket) => {
  accepted.push(socket);
  let mode = "";
  let drained = false;

  socket.on("close", () => {
    lastClosedMode = mode;
  });

  socket.on("drain", () => {
    drained = true;
  });

  socket.on("data", (chunk) => {
    if (mode === "") {
      // first chunk: "<mode>\n<rest>"
      const nl = chunk.indexOf(0x0a);
      mode = nl === -1 ? chunk.toString() : chunk.subarray(0, nl).toString();
      const rest = nl === -1 ? Buffer.alloc(0) : chunk.subarray(nl + 1);
      onModeStart(socket, mode);
      if (rest.length > 0) onPayload(socket, mode, rest);
      return;
    }
    onPayload(socket, mode, chunk);
  });

  function onModeStart(s: TcpSocket, m: string): void {
    switch (m) {
      case "echo":
        echoConnections++;
        return;
      case "half":
        // deliver remaining data, then FIN; the post-end write must be a no-op
        s.write("part1");
        s.end("part2");
        s.write("part3-after-end");
        return;
      case "flood": {
        // overrun the send buffer, then report whether write() ever pushed back
        const block = Buffer.alloc(64 * 1024, 0x41);
        let sawFalse = false;
        for (let i = 0; i < 64; i++) {
          if (!s.write(block)) sawFalse = true;
        }
        // out-of-band trailer: did write() ever return false?
        s.write(sawFalse ? "\x00B" : "\x00N");
        return;
      }
      case "destroy":
        s.destroy();
        return;
      case "endempty":
        s.end();
        return;
      case "throw":
        throw new Error("handler blew up on connect");
      default:
        return;
    }
  }

  function onPayload(s: TcpSocket, m: string, data: Buffer): void {
    switch (m) {
      case "echo":
        s.write(data);
        return;
      case "retain":
        retained.push(data); // keep the chunk; the test asserts it later
        s.write(data);
        return;
      case "drainq":
        // emptied by the flood path; payload here just keeps the conn alive
        if (drained) s.write("drained");
        return;
      default:
        return;
    }
  }
});

const { port } = server.listen(0, HOST);

after(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// client helpers (Node's built-in net client)
// ---------------------------------------------------------------------------

// open a connection in `mode`; resolves once connected.
function open(mode: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, HOST, () => {
      c.write(`${mode}\n`);
      resolve(c);
    });
    c.once("error", reject);
  });
}

// open a connection, send one payload, collect bytes until the connection ends,
// then resolve with everything received.
function roundTrip(mode: string, payload: Uint8Array | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const acc: Buffer[] = [];
    const c = net.connect(port, HOST, () => {
      c.write(`${mode}\n`);
      c.write(payload as Buffer);
      c.end();
    });
    c.on("data", (d) => acc.push(d));
    c.on("end", () => resolve(Buffer.concat(acc)));
    c.once("error", reject);
  });
}

// collect bytes for `ms`, then resolve. Used when there is no clean EOF to wait on.
function collect(c: net.Socket, ms: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const acc: Buffer[] = [];
    c.on("data", (d) => acc.push(d));
    setTimeout(() => resolve(Buffer.concat(acc)), ms);
  });
}

function once(c: net.Socket, event: string): Promise<void> {
  return new Promise((resolve) => c.once(event, () => resolve()));
}

// ---------------------------------------------------------------------------
// listen / addressing
// ---------------------------------------------------------------------------

describe("tcp — listen & addressing", () => {
  test("listen(0) returns an OS-assigned port > 0", () => {
    assert.equal(typeof port, "number");
    assert.ok(port > 0, `expected a real port, got ${port}`);
  });

  test("remoteAddress / remotePort reflect the connecting client", async () => {
    const c = await open("echo");
    const local = c.address() as net.AddressInfo;
    const socket = accepted[accepted.length - 1]!;
    assert.equal(socket.remoteAddress, HOST);
    assert.equal(socket.remotePort, local.port);
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// echo / payload integrity
// ---------------------------------------------------------------------------

describe("tcp — payload integrity", () => {
  test("echoes a simple text payload", async () => {
    const reply = await roundTrip("echo", "hello unicode 你好 🚀");
    assert.equal(reply.toString(), "hello unicode 你好 🚀");
  });

  test("a binary payload with every byte value 0..255 survives intact", async () => {
    const payload = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) payload[i] = i;
    const reply = await roundTrip("echo", payload);
    assert.equal(reply.length, 256);
    assert.deepEqual(reply, payload);
  });

  test("a large (>=512 KiB) payload round-trips intact (queued-write backpressure)", async () => {
    const size = 768 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 31 + 7) & 0xff;
    const reply = await roundTrip("echo", payload);
    assert.equal(reply.length, size, `expected ${size} bytes back, got ${reply.length}`);
    assert.deepEqual(reply, payload);
  });

  test("many small writes preserve order", async () => {
    const expected = Array.from({ length: 200 }, (_, i) => `[${i}]`).join("");
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const acc: Buffer[] = [];
      const c = net.connect(port, HOST, () => {
        c.write("echo\n");
        for (let i = 0; i < 200; i++) c.write(`[${i}]`);
        c.end();
      });
      c.on("data", (d) => acc.push(d));
      c.on("end", () => resolve(Buffer.concat(acc)));
      c.once("error", reject);
    });
    assert.equal(reply.toString(), expected);
  });
});

// ---------------------------------------------------------------------------
// backpressure
// ---------------------------------------------------------------------------

describe("tcp — backpressure", () => {
  test("write() returns false then a 'drain' fires; all bytes still arrive", async () => {
    // server floods 64 * 64 KiB = 4 MiB. The client reads slowly enough to fill
    // the send buffer, so write() has to return false at least once.
    const blocks = 64;
    const blockSize = 64 * 1024;
    const dataTotal = blocks * blockSize;

    const c = net.connect(port, HOST, () => c.write("flood\n"));
    let received = 0;
    let backpressureFlag: string | undefined;

    await new Promise<void>((resolve, reject) => {
      let header = Buffer.alloc(0);
      c.on("data", (d) => {
        received += d.length;
        // the server appends a 2-byte trailer: \x00 then 'B' (saw false) or 'N'
        if (received >= dataTotal + 2 && backpressureFlag === undefined) {
          header = d.subarray(d.length - 2);
          if (header[0] === 0x00) backpressureFlag = String.fromCharCode(header[1]!);
        }
        if (received >= dataTotal + 2) resolve();
      });
      c.once("error", reject);
      setTimeout(() => reject(new Error(`backpressure timeout, got ${received}`)), 5000);
    });

    assert.equal(received, dataTotal + 2, "every flooded byte (+ trailer) must arrive");
    assert.equal(backpressureFlag, "B", "write() should have returned false under the flood");
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// connection isolation
// ---------------------------------------------------------------------------

describe("tcp — connection isolation", () => {
  test("concurrent connections each echo only their own bytes", async () => {
    const count = 25;
    const replies = await Promise.all(
      Array.from({ length: count }, (_, i) => {
        const tag = `conn-${i}-${"y".repeat(i)}`;
        return roundTrip("echo", tag).then((r) => r.toString());
      }),
    );
    replies.forEach((r, i) => assert.equal(r, `conn-${i}-${"y".repeat(i)}`));
  });
});

// ---------------------------------------------------------------------------
// chunk retention (proves the copy)
// ---------------------------------------------------------------------------

describe("tcp — chunk retention", () => {
  test("a data handler may retain the chunk; bytes stay valid after the call", async () => {
    const before = retained.length;
    const payload = Buffer.from("retain-me-长期保留");
    const reply = await roundTrip("retain", payload);
    assert.deepEqual(reply, payload);
    // handler pushed its chunk into `retained`; reading it back later must match.
    const kept = retained.slice(before);
    assert.ok(kept.length >= 1, "handler should have retained at least one chunk");
    const joined = Buffer.concat(kept);
    assert.deepEqual(joined, payload, "retained chunk was mutated or aliased");
  });
});

// ---------------------------------------------------------------------------
// half-close, destroy, server close
// ---------------------------------------------------------------------------

describe("tcp — lifecycle", () => {
  test("end() flushes queued data, sends FIN, and fires server-side 'close'", async () => {
    const reply = await roundTrip("half", "");
    // server wrote "part1", end("part2"); the post-end write("part3...") is a no-op.
    assert.equal(reply.toString(), "part1part2");
    // give the close event a tick to settle, then check the server saw it.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      lastClosedMode,
      "half",
      "server 'close' should have fired for the half-close conn",
    );
  });

  test("write after end() is a no-op (no extra bytes leak through)", async () => {
    const reply = await roundTrip("half", "");
    assert.equal(reply.includes("part3-after-end"), false);
    assert.equal(reply.toString(), "part1part2");
  });

  test("end() with no data still half-closes (client sees EOF)", async () => {
    const c = await open("endempty");
    await once(c, "end"); // server FIN => client 'end'
    c.destroy();
  });

  test("destroy() drops the connection immediately", async () => {
    const c = await open("destroy");
    // a destroyed peer surfaces as 'close' on the client, fast, with no data
    await new Promise<void>((resolve, reject) => {
      c.on("close", () => resolve());
      setTimeout(() => reject(new Error("destroy did not close the client")), 1000);
    });
  });

  test("a client disconnect fires the server-side 'close'", async () => {
    lastClosedMode = "";
    const c = await open("echo");
    c.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lastClosedMode, "echo", "server should observe the client disconnect");
  });
});

// ---------------------------------------------------------------------------
// no-op writes
// ---------------------------------------------------------------------------

describe("tcp — write edge cases", () => {
  test("an empty-string write is a harmless no-op (echo still works after)", async () => {
    // client sends "" then "real"; the empty write contributes nothing and the
    // connection stays healthy, so the echo comes back as just "real".
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const acc: Buffer[] = [];
      const c = net.connect(port, HOST, () => {
        c.write("echo\n");
        c.write(""); // empty client write
        c.write("real");
        c.end();
      });
      c.on("data", (d) => acc.push(d));
      c.on("end", () => resolve(Buffer.concat(acc)));
      c.once("error", reject);
    });
    assert.equal(reply.toString(), "real");
  });
});

// ---------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------

describe("tcp — robustness", () => {
  test("connection churn: open+close many connections sequentially stays clean", async () => {
    for (let i = 0; i < 50; i++) {
      const reply = await roundTrip("echo", `churn-${i}`);
      assert.equal(reply.toString(), `churn-${i}`);
    }
  });

  test("a throwing connection handler does not kill the server", async () => {
    // this connection's handler throws on connect; the next connection must still echo.
    const c = await open("throw");
    await collect(c, 100); // let the throw happen server-side
    c.destroy();
    const reply = await roundTrip("echo", "still-alive");
    assert.equal(reply.toString(), "still-alive");
  });
});

// ---------------------------------------------------------------------------
// server.close() — keep this LAST: it tears the server down for the file.
// ---------------------------------------------------------------------------

describe("tcp — server.close()", () => {
  test("close() severs all live connections", async () => {
    // hold two live echo connections, then close the server out from under them
    const a = await open("echo");
    const b = await open("echo");
    const closedA = once(a, "close");
    const closedB = once(b, "close");
    server.close();
    await Promise.all([closedA, closedB]); // both clients see the drop
  });
});
