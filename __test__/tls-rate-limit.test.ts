import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import tls from "node:tls";
import { createTcpServer } from "../ts/index.ts";
import { certFixture } from "./tls-helpers.ts";

// The accept guard fires before the TLS state machine exists: an over-limit peer is
// reset without the server doing any handshake work, which is the whole point — a
// handshake flood costs key exchanges, an accept-guard reset costs a hash lookup.

const HOST = "127.0.0.1";
const MAX = 2;

let handled = 0;
const server = createTcpServer(
  (socket) => {
    handled++;
    socket.write("secure hello");
  },
  {
    rateLimit: { max: MAX, windowMs: 60_000 },
    tls: { cert: certFixture("ec-cert.pem"), key: certFixture("ec-key.pem") },
  },
);
const { port } = server.listen(0, HOST);

after(() => server.close());

function handshake(): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const c = tls.connect({ port, host: HOST, ca: certFixture("ec-cert.pem") }, () => {
      // handshake completed; wait for the app greeting then leave
      c.once("data", () => {
        c.destroy();
        resolve({ ok: true });
      });
    });
    c.on("error", () => resolve({ ok: false }));
    c.on("close", () => resolve({ ok: false })); // reset before secureConnect
  });
}

describe("tls — accept guard rejects before the handshake", () => {
  test("over-limit peers never complete a handshake; under-limit ones do", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < MAX + 3; i++) results.push((await handshake()).ok);
    assert.deepEqual(results.slice(0, MAX), [true, true]);
    for (const ok of results.slice(MAX)) assert.equal(ok, false);
    assert.equal(handled, MAX); // the handler saw exactly the admitted sessions
  });
});
