// A raw UDP server: echo every datagram, plus a tiny STATS request/response.
// run:  node examples/udp.ts
// test: echo -n PING  | nc -u -w1 127.0.0.1 9001    (echoes PING back)
//       echo -n STATS | nc -u -w1 127.0.0.1 9001    (returns packet/byte counts)
import { createUdpServer } from "@usetoki/toki";

const PORT = 9001;
const HOST = "127.0.0.1";

let packets = 0;
let bytes = 0;

const sock = createUdpServer((msg, rinfo, socket) => {
  packets += 1;
  bytes += msg.length;
  console.log(`recv ${msg.length}B from ${rinfo.address}:${rinfo.port}`);

  // Empty datagrams are delivered too — treat them as a plain echo.
  if (msg.toString("utf8").trim().toUpperCase() === "STATS") {
    socket.send(`packets=${packets} bytes=${bytes}\n`, rinfo.port, rinfo.address);
    return;
  }

  // Echo the datagram straight back to the sender (the buffer is a safe-to-keep copy).
  socket.send(msg, rinfo.port, rinfo.address);
});

const { port } = sock.bind(PORT, HOST);
console.log(`udp server on ${HOST}:${port} — try:  echo -n STATS | nc -u -w1 ${HOST} ${port}`);

// Graceful shutdown: stop receiving and close the socket.
process.on("SIGINT", () => {
  console.log("\nshutting down");
  sock.close();
  process.exit(0);
});
