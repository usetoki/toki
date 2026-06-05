import assert from "node:assert/strict";
import { connect as netConnect } from "node:net";
import { after, test } from "node:test";
import { createApp, reply } from "../dist/index.js";
import { certFixture } from "./tls-helpers.ts";

const app = createApp({ logger: false });
app.get("/", () => reply.text("ok"));
const handle = app.listen(0, {
  host: "127.0.0.1",
  headerTimeoutMs: 300, // close connections stalled mid-request/handshake
  tls: { cert: certFixture("ec-cert.pem"), key: certFixture("ec-key.pem") },
});
after(() => handle.close());

test("a stalled TLS handshake is closed by the slowloris sweep", async () => {
  const closed = await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean): void => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const sock = netConnect(handle.port, "127.0.0.1", () => {
      // a handshake record claiming 256 payload bytes but sending only one — never completes
      sock.write(Buffer.from([0x16, 0x03, 0x01, 0x01, 0x00, 0x01]));
    });
    sock.on("close", () => finish(true));
    sock.on("error", () => finish(true));
    // the sweep runs every 1s against a 300ms timeout — comfortably under this bound
    setTimeout(() => {
      sock.destroy();
      finish(false);
    }, 2500);
  });
  assert.ok(closed, "the server should drop a connection stalled mid-handshake");
});
