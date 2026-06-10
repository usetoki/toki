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

  // Triggering the cap needs the client to drain slower than the server produces while
  // still reading enough to observe the eventual reset. The margin between those depends on
  // the socket buffer size: on Unix loopback it's wide (one large write queues past the cap
  // at once), on Windows it's narrow enough that a drip reader keeps the backlog under the
  // ceiling. The cap logic is identical across platforms; only this loopback test is
  // buffer-sensitive, so skip the assertion on Windows rather than make it flaky.
  const capTest = process.platform === "win32" ? test.skip : test;
  capTest("a slow reader past the cap is dropped before the whole body arrives", async () => {
    const port = await freePort();
    handle = app.listen(port, { host: "127.0.0.1", maxWriteQueue: 64 * 1024 });

    // The OS-independent invariant: a client that drains far slower than the server
    // produces must have its connection dropped well before the full 96 MB lands —
    // the server caps its backlog and lets go, rather than buffering it all. A drip
    // reader (read a little, stall, read again) keeps the socket in reading mode so a
    // reset surfaces here, while still building the server-side queue past the cap.
    const total = big.length;
    const outcome = await new Promise<string>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write("GET /big HTTP/1.1\r\nHost: x\r\n\r\n");
        sock.pause();
      });
      let received = 0;
      sock.on("data", (d) => {
        received += d.length;
        sock.pause(); // take one chunk, then stall — the drip is driven by the timer
      });
      const drip = setInterval(() => sock.resume(), 120);
      let settled = false;
      const done = (v: string) => {
        if (settled) return;
        settled = true;
        clearInterval(drip);
        sock.destroy();
        resolve(v);
      };
      sock.on("close", () => done(received >= total ? "full-body" : "dropped"));
      sock.on("error", () => done("dropped"));
      setTimeout(() => done(received >= total ? "full-body" : `open:${received}`), 15000);
    });

    assert.equal(
      outcome,
      "dropped",
      "server should drop a slow reader past the cap before the whole body lands",
    );
  });
});
