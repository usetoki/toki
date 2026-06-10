import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { createTcpServer, type TcpSocket } from "../ts/index.ts";
import { freePort } from "./helpers.ts";

// The io_uring backend, exercised over real loopback sockets. Linux only (the engine
// throws/falls back elsewhere), so the whole suite skips off-Linux. One server for the
// file — the native engine is a singleton.
const linux = process.platform === "linux";
const suite = linux ? describe : describe.skip;

const HOST = "127.0.0.1";
const END = "__END__";
const KILL = "__KILL__";
const PEER = "__PEER__";
const CAP = 4 * 1024 * 1024; // write-queue cap, small enough to exercise on purpose

suite("tcp — io_uring backend", () => {
  let port = 0;
  let live = 0;
  let accepted = 0;
  const server = createTcpServer(
    (socket: TcpSocket) => {
      accepted++;
      live++;
      socket.on("data", (chunk) => {
        const s = chunk.length <= 16 ? chunk.toString("latin1") : "";
        if (s === END) return void socket.end("bye");
        if (s === KILL) return void socket.destroy();
        if (s === PEER) return void socket.end(`${socket.remoteAddress}:${socket.remotePort}`);
        socket.write(chunk); // echo
      });
      socket.on("close", () => void live--);
    },
    { engine: "io_uring", maxWriteQueue: CAP },
  );

  before(async () => {
    port = await freePort();
    server.listen(port, HOST);
  });
  after(() => server.close());

  // connect, run `drive` with the socket, resolve with everything received before close
  function run(drive: (c: net.Socket) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const c = net.connect(port, HOST, () => drive(c));
      c.on("data", (d) => chunks.push(d));
      c.on("error", reject);
      c.on("close", () => resolve(Buffer.concat(chunks)));
    });
  }

  // send `payload`, then half-close; resolve with the echo
  const echo = (payload: Buffer | string) =>
    run((c) => {
      c.write(payload);
      c.end();
    });

  test("echoes a small payload", async () => {
    assert.equal((await echo("hello io_uring")).toString(), "hello io_uring");
  });

  test("an empty write produces an empty, clean exchange", async () => {
    assert.equal((await echo("")).length, 0);
  });

  test("preserves byte order across many small writes", async () => {
    const out = await run((c) => {
      for (let i = 0; i < 500; i++) c.write(String.fromCharCode(97 + (i % 26)));
      c.end();
    });
    let expected = "";
    for (let i = 0; i < 500; i++) expected += String.fromCharCode(97 + (i % 26));
    assert.equal(out.toString(), expected);
  });

  test("round-trips payloads at the provided-buffer boundary (16 KiB ± 1, 64 KiB)", async () => {
    for (const size of [16 * 1024 - 1, 16 * 1024, 16 * 1024 + 1, 64 * 1024]) {
      const payload = Buffer.alloc(size);
      for (let i = 0; i < size; i++) payload[i] = (i * 31) & 0xff;
      const out = await echo(payload);
      assert.equal(out.length, size, `size ${size}`);
      assert.ok(out.equals(payload), `bytes for size ${size}`);
    }
  });

  test("a large payload round-trips byte-for-byte (multishot recv, partial sends)", async () => {
    // request/response window: one chunk in flight at a time keeps the server's echo queue
    // tiny, so this verifies integrity across 12 MB without depending on the write cap.
    const size = 12 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 131) & 0xff;
    const chunk = 256 * 1024;

    const out = await new Promise<Buffer>((resolve, reject) => {
      const got = Buffer.alloc(size);
      let sent = 0;
      let recv = 0;
      const c = net.connect(port, HOST, () => c.write(payload.subarray(0, Math.min(chunk, size))));
      c.on("data", (d) => {
        d.copy(got, recv);
        recv += d.length;
        // advance the send window as the echo of the previous chunk lands
        while (sent < size && sent < recv + chunk) {
          const end = Math.min(sent + chunk, size);
          c.write(payload.subarray(sent, end));
          sent = end;
        }
        if (recv >= size) c.end();
      });
      c.on("error", reject);
      c.on("close", () => resolve(got));
    });
    assert.ok(out.equals(payload), "12 MB echoed intact");
  });

  test("many concurrent connections each echo independently", async () => {
    const n = 300;
    const results = await Promise.all(Array.from({ length: n }, (_, i) => echo(`conn-${i}`)));
    for (let i = 0; i < n; i++) assert.equal(results[i]!.toString(), `conn-${i}`);
  });

  test("server-initiated half-close: client reads final bytes then EOF", async () => {
    assert.equal((await echo(END)).toString(), "bye");
  });

  test("server-initiated destroy tears the client down", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const c = net.connect(port, HOST, () => c.write(KILL));
      c.on("data", () => {});
      c.on("error", () => resolve("down"));
      c.on("close", () => resolve("down"));
      setTimeout(() => resolve("hung"), 4000);
    });
    assert.equal(outcome, "down");
  });

  test("destroy right at connect (before any data) is clean", async () => {
    // open many, immediately half-close before writing — exercises accept→close with no IO
    await Promise.all(
      Array.from(
        { length: 50 },
        () =>
          new Promise<void>((resolve) => {
            const c = net.connect(port, HOST, () => c.end());
            c.on("error", () => resolve());
            c.on("close", () => resolve());
          }),
      ),
    );
  });

  test("peer address is reported (lazy getpeername)", async () => {
    const text = (await echo(PEER)).toString();
    assert.match(text, /^127\.0\.0\.1:\d+$/, `got ${text}`);
  });

  test("write-queue cap resets a peer that stops reading", async () => {
    // ask the server to echo a flood and then never read it: the echo backlog blows the
    // 4 MB cap and the server resets us. The flood (48 MB) is far past any loopback kernel
    // buffer, so the backlog genuinely has to queue in the server's heap.
    const flood = Buffer.alloc(48 * 1024 * 1024, 0x7a);
    const outcome = await new Promise<string>((resolve) => {
      const c = net.connect(port, HOST, () => {
        c.write(flood);
        c.pause(); // never drain the echo
      });
      c.on("error", () => resolve("reset"));
      c.on("close", () => resolve("reset"));
      setTimeout(() => {
        c.destroy();
        resolve("open");
      }, 8000);
    });
    assert.equal(outcome, "reset", "server should drop a peer over the write cap");
  });

  test("rapid connect/echo/close churn stays healthy", async () => {
    const start = accepted;
    for (let b = 0; b < 15; b++) {
      await Promise.all(Array.from({ length: 100 }, () => echo("x")));
    }
    assert.equal(accepted - start, 1500);
    assert.equal((await echo("still-alive")).toString(), "still-alive");
  });

  test("all connections drain to zero (no leaked live conns)", async () => {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(live, 0);
  });
});
