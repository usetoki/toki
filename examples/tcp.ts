// A raw TCP server: a line-delimited command protocol (PING/ECHO/QUIT) over native libuv.
// run:  node examples/tcp.ts
// test: nc 127.0.0.1 9000   then type:  PING  /  ECHO hi  /  QUIT
import { createTcpServer } from "@usetoki/toki";
import type { TcpSocket } from "@usetoki/toki";

const PORT = 9000;
const HOST = "127.0.0.1";

const server = createTcpServer((socket) => {
  const who = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`connect ${who}`);

  // Per-connection state: a text buffer split on newlines, plus a backpressure flag.
  let buffer = "";
  let paused = false;
  const outbox: string[] = [];

  // Queue writes so we don't push past a full send buffer.
  const send = (line: string): void => {
    if (paused) {
      outbox.push(line);
      return;
    }
    // write() returns false once the socket buffer backs up. stop and wait for "drain".
    if (!socket.write(line)) paused = true;
  };

  socket.on("drain", () => {
    paused = false;
    while (outbox.length > 0 && !paused) {
      if (!socket.write(outbox.shift() as string)) paused = true;
    }
  });

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    // Guard against a client that never sends a newline.
    if (buffer.length > 64 * 1024) {
      socket.end("ERR line too long\r\n");
      return;
    }

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (handle(socket, line, send)) return; // QUIT closed the socket
    }
  });

  socket.on("close", () => console.log(`close   ${who}`));
});

// Returns true when the connection was closed and parsing should stop.
function handle(socket: TcpSocket, line: string, send: (s: string) => void): boolean {
  const sp = line.indexOf(" ");
  const cmd = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
  const rest = sp === -1 ? "" : line.slice(sp + 1);

  switch (cmd) {
    case "":
      return false; // blank line, ignore
    case "PING":
      send("PONG\r\n");
      return false;
    case "ECHO":
      send(`${rest}\r\n`);
      return false;
    case "QUIT":
      socket.end("BYE\r\n"); // flush, then half-close
      return true;
    default:
      send(`ERR unknown command ${cmd}\r\n`);
      return false;
  }
}

const { port } = server.listen(PORT, HOST);
console.log(`tcp server on ${HOST}:${port} — try:  nc ${HOST} ${port}`);

// Graceful shutdown: stop accepting and drop live connections.
process.on("SIGINT", () => {
  console.log("\nshutting down");
  server.close();
  process.exit(0);
});
