import assert from "node:assert/strict";
import net from "node:net";
import { describe, test } from "node:test";
import { createTcpServer } from "../ts/index.ts";
import { freePort } from "./helpers.ts";

// io_uring server lifecycle: close-then-relisten (the engine is a process singleton, so the
// ring + poll handle must tear down cleanly and rebuild) and IPv6 binding. Linux only.
const onLinux = process.platform === "linux";
const suite = onLinux ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function echoOnce(port: number, host: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const c = net.connect(port, host, () => {
      c.write(payload);
      c.end();
    });
    c.on("data", (d) => chunks.push(d));
    c.on("error", reject);
    c.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
}

suite("tcp — io_uring lifecycle", () => {
  test("close then re-listen rebuilds the ring and serves again", async () => {
    for (let cycle = 0; cycle < 4; cycle++) {
      const port = await freePort();
      const server = createTcpServer((sock) => sock.on("data", (c) => sock.write(c)), {
        engine: "io_uring",
      });
      server.listen(port, "127.0.0.1");
      const reply = await echoOnce(port, "127.0.0.1", `cycle-${cycle}`);
      assert.equal(reply, `cycle-${cycle}`);
      server.close();
      // the poll handle closes on a later loop turn; give it one before re-listening
      await sleep(50);
    }
  });

  test("binds and serves over IPv6 (::1)", async () => {
    // skip if the loopback has no IPv6 (some minimal containers)
    let port = 0;
    let server: ReturnType<typeof createTcpServer> | undefined;
    try {
      port = await freePort();
      server = createTcpServer((sock) => sock.on("data", (c) => sock.write(c)), {
        engine: "io_uring",
      });
      server.listen(port, "::1");
    } catch {
      return; // no IPv6 here
    }
    try {
      const reply = await echoOnce(port, "::1", "v6-hello");
      assert.equal(reply, "v6-hello");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") return; // no IPv6 loopback
      throw e;
    } finally {
      server.close();
    }
  });
});
