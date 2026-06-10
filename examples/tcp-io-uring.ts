// The same raw TCP echo server as tcp.ts, but on the io_uring backend instead of libuv.
// On Linux with a recent kernel it runs accept/recv/send through an io_uring ring driven
// on Node's own loop — lower syscall overhead, flat memory under many connections. On
// macOS/Windows, on an old kernel, or where a container blocks the io_uring syscalls, it
// prints a one-line notice and falls back to the libuv engine, so the same code runs
// everywhere.
//
// run:  node examples/tcp-io-uring.ts
// test: nc 127.0.0.1 9000   then type a line; it echoes back
//
// In a container the io_uring syscalls are usually blocked by the default seccomp profile;
// allow them with `docker run --security-opt seccomp=unconfined ...` (or a profile that
// permits io_uring_setup/io_uring_enter/io_uring_register) to actually use the engine.
import { createTcpServer } from "@usetoki/toki";

const PORT = 9000;
const HOST = "127.0.0.1";

const server = createTcpServer(
  (socket) => {
    console.log(`connect ${socket.remoteAddress}:${socket.remotePort}`);

    // echo with real backpressure: write() returns false once the send backlog fills, so
    // pause and resume on drain rather than letting a slow reader balloon server memory.
    let paused = false;
    const backlog: Buffer[] = [];
    socket.on("data", (chunk) => {
      if (paused) {
        backlog.push(chunk);
        return;
      }
      if (!socket.write(chunk)) paused = true;
    });
    socket.on("drain", () => {
      paused = false;
      while (backlog.length > 0 && !paused) {
        if (!socket.write(backlog.shift() as Buffer)) paused = true;
      }
    });

    socket.on("close", () => console.log(`close   ${socket.remoteAddress}:${socket.remotePort}`));
  },
  {
    engine: "io_uring",
    // a connection whose peer stops reading is reset past this backlog (default 16 MiB)
    maxWriteQueue: 8 * 1024 * 1024,
  },
);

const { port } = server.listen(PORT, HOST);
console.log(`echo server on ${HOST}:${port} (io_uring where available, else libuv)`);
