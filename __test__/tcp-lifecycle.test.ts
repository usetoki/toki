import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { createTcpServer, type TcpSocket } from "../ts/index.ts";

// Connection lifecycle on the raw server: pause/resume (backpressure) and stopAccepting. One
// server per process; stopAccepting flips a process-wide flag, so its test runs last.
let pauseMode = false;
const pauseResult: { data?: string; resumedFirst?: boolean } = {};

const server = createTcpServer(
  (sock: TcpSocket) => {
    if (pauseMode) {
      sock.pause();
      let resumed = false;
      sock.on("data", (c) => {
        pauseResult.data = c.toString();
        pauseResult.resumedFirst = resumed; // true only if resume() ran before the data arrived
      });
      setTimeout(() => {
        resumed = true;
        sock.resume();
      }, 80);
      return;
    }
    sock.write("ok");
  },
  { keepAlive: true, keepAliveDelaySecs: 30 },
);
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
}

test("pause() holds incoming data until resume()", async () => {
  pauseMode = true;
  const c = await connect();
  c.write("buffered-while-paused");
  // the server paused immediately; the data must not surface until resume() runs (~80ms).
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(pauseResult.data, "buffered-while-paused", "the data was delivered after resume");
  assert.equal(pauseResult.resumedFirst, true, "it arrived only after resume(), not while paused");
  c.destroy();
  pauseMode = false;
});

test("stopAccepting() rejects new connections; live ones keep working", async () => {
  const live = await connect();
  await new Promise<void>((r) => live.once("data", () => r())); // got "ok"
  server.stopAccepting();
  const rejected = net.connect(port, "127.0.0.1");
  let gotData = false;
  rejected.on("data", () => (gotData = true));
  // the server resets the connection — surfaces as an error and/or a close, both expected.
  await new Promise<void>((resolve) => {
    rejected.on("error", () => resolve());
    rejected.on("close", () => resolve());
  });
  assert.equal(gotData, false, "a new connection after stopAccepting got no data");
  assert.equal(live.destroyed, false, "the live connection was untouched");
  live.destroy();
});
