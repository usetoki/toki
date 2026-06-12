import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { createTcpServer } from "../ts/index.ts";

// maxConnections caps concurrent connections; a new accept past the cap is reset before the
// handler sees it. Its own process so the cap doesn't perturb the other lifecycle tests.
const server = createTcpServer((sock) => sock.write("ok"), { maxConnections: 2 });
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
}

test("a connection past maxConnections is reset with no data", async () => {
  const a = await connect();
  const b = await connect();
  await new Promise((r) => setTimeout(r, 50)); // let both register against the cap
  const over = net.connect(port, "127.0.0.1");
  let gotData = false;
  over.on("data", () => (gotData = true));
  await new Promise<void>((resolve) => {
    over.on("error", () => resolve());
    over.on("close", () => resolve());
  });
  assert.equal(gotData, false, "the over-cap connection got no data before being reset");
  a.destroy();
  b.destroy();
});

test("a new connection succeeds again once below the cap", async () => {
  // the two above were destroyed; give the server a moment to drop them, then connect.
  await new Promise((r) => setTimeout(r, 150));
  const c = await connect();
  const ok = await new Promise<string>((resolve) => c.once("data", (d) => resolve(d.toString())));
  assert.equal(ok, "ok", "a connection within the cap is served normally");
  c.destroy();
});
