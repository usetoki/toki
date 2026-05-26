import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";

import { reply } from "../ts";
import { withServer } from "./helpers";

describe("graceful shutdown", () => {
  test("a request before close succeeds, and connections are refused after", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("up"));
      },
      { shutdownTimeoutMs: 1000 },
    );

    const before = await fetch(`${server.base}/`);
    assert.equal(before.status, 200);
    assert.equal(await before.text(), "up");

    server.close();

    // After close the accept loop stops; a new connection eventually fails. Poll
    // with a bound to absorb the brief window before the listener is fully down.
    let failed = false;
    for (let attempt = 0; attempt < 50 && !failed; attempt += 1) {
      try {
        const res = await fetch(`${server.base}/`);
        await res.body?.cancel();
        await delay(20);
      } catch {
        failed = true;
      }
    }
    assert.ok(failed, "a fetch after close should fail to connect");
  });

  test("close is idempotent and safe to call when not listening", async () => {
    const server = await withServer((app) => {
      app.get("/", () => reply.text("ok"));
    });
    server.close();
    // A second close must not throw.
    assert.doesNotThrow(() => server.close());
  });
});
