import assert from "node:assert/strict";
import net from "node:net";
import { after, describe, test } from "node:test";
import { createApp, reply } from "../ts/index.ts";
import { freePort } from "./helpers.ts";

// These exercise the connection-lifecycle resource fixes: re-listen teardown (the native
// engine frees the prior route/static tables and dispatch ref instead of stranding them)
// and the HTTP write-queue cap (a non-reading peer is dropped, not buffered without bound).

describe("re-listen reuses the engine without stranding state", () => {
  test("listen → close → listen serves correctly across many cycles", async () => {
    const app = createApp({ logger: false });
    app.get("/", () => reply.text("ok"));
    app.get("/n/:id", (req) => reply.json({ id: req.params.id }));

    for (let cycle = 0; cycle < 8; cycle++) {
      const port = await freePort();
      const handle = app.listen(port, { host: "127.0.0.1" });
      try {
        const a = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(await a.text(), "ok");
        const b = await fetch(`http://127.0.0.1:${port}/n/${cycle}`);
        assert.deepEqual(await b.json(), { id: String(cycle) });
      } finally {
        handle.close();
        // let the listen socket finish closing before the next bind
        await new Promise((r) => setTimeout(r, 30));
      }
    }
  });
});

describe("HTTP write-queue cap drops a non-reading peer", () => {
  // a tiny cap makes the bound deterministic: one large response a paused client never
  // drains must blow it and get the connection closed, not buffered to OOM.
  const app = createApp({ logger: false });
  // far past any loopback kernel send/recv buffer, so the unflushed tail genuinely has
  // to queue in our heap and trip the cap rather than being absorbed by the OS.
  const big = "y".repeat(96 * 1024 * 1024);
  app.get("/big", () => reply.text(big));

  let handle: { close(): void } | undefined;
  after(() => handle?.close());

  test("a slow reader past the cap is reset, not buffered unbounded", async () => {
    const port = await freePort();
    handle = app.listen(port, { host: "127.0.0.1", maxWriteQueue: 64 * 1024 });

    // read just enough to fill the kernel buffer then stop draining for a beat: the
    // server's backlog blows the 64 KB cap and it resets us. We keep the socket in
    // reading mode (not paused) so the RST surfaces as a close/error here.
    const outcome = await new Promise<string>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write("GET /big HTTP/1.1\r\nHost: x\r\n\r\n");
      });
      let received = 0;
      sock.on("data", (d) => {
        received += d.length;
        // stall the reader once we've taken a little, forcing the server to queue
        if (received > 128 * 1024) sock.pause();
      });
      let settled = false;
      const done = (v: string) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      sock.on("close", () => done("closed"));
      sock.on("error", () => done("closed"));
      // resume late so the buffered reset is delivered to JS even if we stalled
      setTimeout(() => sock.resume(), 1500);
      setTimeout(() => done(`open:${received}`), 8000);
    });

    assert.equal(outcome, "closed", "server should reset a peer that exceeds the write-queue cap");
    // the server must not have streamed the whole 96 MB body before resetting
  });
});
