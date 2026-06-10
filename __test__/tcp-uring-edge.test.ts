import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { createTcpServer, type TcpSocket } from "../ts/index.ts";
import { freePort } from "./helpers.ts";

// Adversarial edge cases for the io_uring backend: lifecycle races, write-after-end,
// half-close variants, server-as-producer backpressure, abrupt resets, reads spanning
// many provided buffers, and mixed concurrent behavior. Linux only; one server per file.
const onLinux = process.platform === "linux";
const suite = onLinux ? describe : describe.skip;

const HOST = "127.0.0.1";
const CAP = 4 * 1024 * 1024;
const PRODUCE = 5 * 1024 * 1024;

// control words (<= 20 bytes); anything else is echoed
const C = {
  END: "@END",
  KILL: "@KILL",
  PEER: "@PEER",
  ENDWRITE: "@ENDWRITE",
  DOUBLEEND: "@DOUBLEEND",
  ENDKILL: "@ENDKILL",
  WK: "@WK",
  PRODUCE: "@PRODUCE",
} as const;
const controls = new Set<string>(Object.values(C));

suite("tcp — io_uring edge cases", () => {
  let port = 0;
  let live = 0;
  let threwCaught = 0;
  const server = createTcpServer(
    (socket: TcpSocket) => {
      live++;
      let producing = false;
      const producePump = () => {
        const buf = Buffer.alloc(64 * 1024, 0x50);
        let left = PRODUCE;
        const step = () => {
          while (left > 0) {
            const n = Math.min(buf.length, left);
            const ok = socket.write(n === buf.length ? buf : buf.subarray(0, n));
            left -= n;
            if (!ok) return; // wait for drain
          }
          socket.end();
        };
        socket.on("drain", step);
        step();
      };
      socket.on("data", (chunk) => {
        const s = chunk.length <= 20 ? chunk.toString("latin1") : "";
        if (!controls.has(s)) {
          socket.write(chunk); // echo
          return;
        }
        switch (s) {
          case C.END:
            socket.end("bye");
            break;
          case C.KILL:
            socket.destroy();
            break;
          case C.PEER:
            socket.end(`${socket.remoteAddress}:${socket.remotePort}`);
            break;
          case C.ENDWRITE:
            socket.end("a");
            socket.write("b"); // must be ignored — write after end
            break;
          case C.DOUBLEEND:
            socket.end("a");
            socket.end("b"); // second end is a no-op
            break;
          case C.ENDKILL:
            socket.end("a");
            socket.destroy();
            break;
          case C.WK:
            socket.write("x");
            socket.destroy(); // destroy with a write still queued
            break;
          case C.PRODUCE:
            if (!producing) {
              producing = true;
              producePump();
            }
            break;
        }
      });
      socket.on("close", () => void live--);
    },
    { engine: "io_uring", maxWriteQueue: CAP },
  );
  // a thrown handler must not take the loop down
  void threwCaught;

  before(async () => {
    port = await freePort();
    server.listen(port, HOST);
  });
  after(() => server.close());

  function collect(drive: (c: net.Socket) => void): Promise<{ data: Buffer; reset: boolean }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let reset = false;
      const c = net.connect(port, HOST, () => drive(c));
      c.on("data", (d) => chunks.push(d));
      c.on("error", () => (reset = true));
      c.on("close", () => resolve({ data: Buffer.concat(chunks), reset }));
    });
  }
  const echo = (p: Buffer | string) =>
    collect((c) => {
      c.write(p);
      c.end();
    });

  test("write after end() is ignored", async () => {
    assert.equal((await echo(C.ENDWRITE)).data.toString(), "a");
  });

  test("a second end() is a no-op", async () => {
    assert.equal((await echo(C.DOUBLEEND)).data.toString(), "a");
  });

  test("destroy() after end() delivers the ended bytes or resets, never hangs", async () => {
    const out = await echo(C.ENDKILL);
    assert.ok(out.data.toString() === "a" || out.data.length === 0);
  });

  test("destroy() with a write still queued tears down cleanly", async () => {
    const out = await echo(C.WK);
    assert.ok(out.data.toString() === "x" || out.data.length === 0);
  });

  test("a single huge write (40 MB) round-trips byte-for-byte", async () => {
    const size = 40 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 197) & 0xff;
    const got = await new Promise<Buffer>((resolve) => {
      const out = Buffer.alloc(size);
      let recv = 0;
      const c = net.connect(port, HOST, () => {
        // window the writes so the client doesn't outrun the server's echo and trip the cap
        let off = 0;
        const pump = () => {
          while (off < size && off < recv + 2 * 1024 * 1024) {
            const end = Math.min(off + 256 * 1024, size);
            c.write(payload.subarray(off, end));
            off = end;
          }
        };
        c.on("__pump" as "drain", pump);
        c.write(payload.subarray(0, 256 * 1024));
        off = 256 * 1024;
      });
      c.on("data", (d) => {
        d.copy(out, recv);
        recv += d.length;
        // refill the window as echoes land
        // (re-derive the writer state via closure would be cleaner; this drives it forward)
        if (recv >= size) c.end();
        else c.emit("__pump" as "drain");
      });
      c.on("close", () => resolve(out));
    });
    assert.ok(got.equals(payload));
  });

  test("byte-at-a-time writes preserve order and content", async () => {
    const n = 1500;
    const out = await collect((c) => {
      let i = 0;
      const tick = () => {
        if (i >= n) {
          c.end();
          return;
        }
        c.write(Buffer.from([(i * 7) & 0xff]));
        i++;
        setImmediate(tick);
      };
      tick();
    });
    assert.equal(out.data.length, n);
    for (let i = 0; i < n; i++) assert.equal(out.data[i], (i * 7) & 0xff);
  });

  test("server as producer streams to a slow reader (backpressure both ways)", async () => {
    const got = await new Promise<number>((resolve) => {
      let recv = 0;
      const c = net.connect(port, HOST, () => c.write(C.PRODUCE));
      c.on("data", (d) => {
        recv += d.length;
        // drip-read: pause briefly so the server's send backlog exercises drain
        c.pause();
        setImmediate(() => c.resume());
      });
      c.on("close", () => resolve(recv));
      c.on("error", () => resolve(recv));
    });
    assert.equal(got, PRODUCE, "received the whole produced stream");
  });

  test("an abrupt client RST mid-stream is handled without crashing the server", async () => {
    const before = live;
    await new Promise<void>((resolve) => {
      const c = net.connect(port, HOST, () => {
        c.write(Buffer.alloc(512 * 1024, 1));
        setTimeout(() => c.resetAndDestroy?.() ?? c.destroy(), 20); // RST
      });
      c.on("error", () => {});
      c.on("close", () => resolve());
    });
    // server still healthy
    assert.equal((await echo("ok")).data.toString(), "ok");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(live <= before + 1);
  });

  test("connect then immediate destroy (no IO) is clean", async () => {
    await Promise.all(
      Array.from(
        { length: 100 },
        () =>
          new Promise<void>((resolve) => {
            const c = net.connect(port, HOST, () => c.destroy());
            c.on("error", () => resolve());
            c.on("close", () => resolve());
          }),
      ),
    );
    assert.equal((await echo("alive")).data.toString(), "alive");
  });

  test("a read spanning several provided buffers (40 KiB) is intact", async () => {
    const size = 40 * 1024; // > 2 buffers of 16 KiB
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 53) & 0xff;
    const out = await echo(payload);
    assert.ok(out.data.equals(payload));
  });

  test("20 concurrent large transfers all stay intact", async () => {
    const size = 2 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 71) & 0xff;
    const transfer = () =>
      new Promise<boolean>((resolve) => {
        const out = Buffer.alloc(size);
        let recv = 0;
        let off = 0;
        const c = net.connect(port, HOST, () => {
          const pump = () => {
            while (off < size && off < recv + 1024 * 1024) {
              const e = Math.min(off + 128 * 1024, size);
              c.write(payload.subarray(off, e));
              off = e;
            }
          };
          c.on("data", (d) => {
            d.copy(out, recv);
            recv += d.length;
            if (recv >= size) c.end();
            else pump();
          });
          pump();
        });
        c.on("error", () => resolve(false));
        c.on("close", () => resolve(out.equals(payload)));
      });
    const results = await Promise.all(Array.from({ length: 20 }, transfer));
    assert.ok(results.every(Boolean), "all 20 transfers intact");
  });

  test("mixed concurrent behaviors leave no live connections", async () => {
    const kinds = ["echo", C.END, C.KILL, "echo", C.PEER];
    await Promise.all(
      Array.from({ length: 250 }, (_, i) => {
        const k = kinds[i % kinds.length]!;
        return echo(k === "echo" ? `m${i}` : k);
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(live, 0);
  });

  test("server stays up across repeated drain cycles", async () => {
    // many sequential producer streams, each fully read — exercises drain repeatedly
    for (let i = 0; i < 5; i++) {
      const recv = await new Promise<number>((resolve) => {
        let n = 0;
        const c = net.connect(port, HOST, () => c.write(C.PRODUCE));
        c.on("data", (d) => (n += d.length));
        c.on("close", () => resolve(n));
        c.on("error", () => resolve(n));
      });
      assert.equal(recv, PRODUCE);
    }
  });
});
