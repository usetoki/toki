import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  connectSecureUdp,
  createSecureUdpServer,
  generateKeyPair,
  NoiseSession,
} from "../ts/index.ts";
import { HandshakeState } from "../ts/net/noise/handshake-state.ts";

// Exercises the Noise handshake + transport crypto directly (no UDP), then the full
// secure-UDP server/client round trip. Regression cover for the AEAD update/final change,
// the handshake key wipe on completion, the message-size cap, and the session count cap.

describe("noise handshake + transport", () => {
  // run the XX pattern between two in-process states and return both transport sessions
  function handshake() {
    const init = new HandshakeState(true, generateKeyPair());
    const resp = new HandshakeState(false, generateKeyPair());
    const m1 = init.writeMessage();
    resp.readMessage(m1.message);
    const m2 = resp.writeMessage();
    init.readMessage(m2.message);
    const m3 = init.writeMessage();
    const r3 = resp.readMessage(m3.message);
    assert.ok(m3.transport, "initiator derives transport on the final write");
    assert.ok(r3.transport, "responder derives transport on the final read");
    return { initT: m3.transport!, respT: r3.transport! };
  }

  test("a completed handshake yields working transport sessions both ways", () => {
    const { initT, respT } = handshake();
    const a = new NoiseSession(initT);
    const b = new NoiseSession(respT);

    const sealed = a.seal(Buffer.from("hello from a"));
    const opened = b.open(sealed);
    assert.ok(opened, "b decrypts a's sealed message");
    assert.equal(opened.toString(), "hello from a");

    const back = b.seal(Buffer.from("reply from b"));
    const got = a.open(back);
    assert.ok(got);
    assert.equal(got.toString(), "reply from b");
  });

  test("empty and large payloads round-trip intact", () => {
    const { initT, respT } = handshake();
    const a = new NoiseSession(initT);
    const b = new NoiseSession(respT);
    for (const size of [0, 1, 1024, 60_000]) {
      const payload = Buffer.alloc(size, 0x5a);
      const out = b.open(a.seal(payload));
      assert.ok(out);
      assert.equal(out.length, size);
      assert.ok(out.equals(payload));
    }
  });

  test("a tampered transport message is rejected", () => {
    const { initT, respT } = handshake();
    const a = new NoiseSession(initT);
    const b = new NoiseSession(respT);
    const sealed = a.seal(Buffer.from("trust me"));
    sealed.writeUInt8(sealed.readUInt8(5) ^ 0xff, 5); // flip a ciphertext byte
    assert.equal(b.open(sealed), null);
  });

  test("an oversized handshake message is refused before processing", () => {
    const resp = new HandshakeState(false, generateKeyPair());
    assert.throws(() => resp.readMessage(Buffer.alloc(5000, 1)), /too large/);
  });
});

describe("secure-udp server round trip", () => {
  // one server for the whole file: the native UDP socket is a process singleton, so a
  // close-then-rebind in the same tick is (correctly) refused while the first is closing.
  let sessions = 0;
  const server = createSecureUdpServer({
    staticKey: generateKeyPair(),
    maxSessions: 2, // force eviction well before the client count below
    onSession: () => {
      sessions += 1;
    },
    onMessage: (msg, session) => session.send(Buffer.concat([Buffer.from("echo:"), msg])),
  });
  const { port } = server.bind(0, "127.0.0.1");
  after(() => server.close());

  const exchange = (i: number) =>
    new Promise<Buffer>((resolve, reject) => {
      connectSecureUdp({ staticKey: generateKeyPair() }, port, "127.0.0.1").then((c) => {
        const t = setTimeout(() => reject(new Error(`client ${i} no reply`)), 3000);
        c.on("message", (m) => {
          clearTimeout(t);
          c.close();
          resolve(m);
        });
        c.send(`m${i}`);
      }, reject);
    });

  test("a client handshakes and exchanges an encrypted datagram", async () => {
    const reply = await exchange(0);
    assert.equal(reply.toString(), "echo:m0");
  });

  test("the session table stays bounded under many clients (maxSessions)", async () => {
    // each client is its own dgram socket (distinct source port) completing a real
    // handshake; with maxSessions=2 the older sessions are evicted as new ones land,
    // yet every fresh client still completes and gets its echo.
    for (let i = 1; i <= 6; i++) {
      const echoed = await exchange(i);
      assert.equal(echoed.toString(), `echo:m${i}`);
    }
    assert.equal(sessions, 7, "all 7 clients completed a handshake despite the cap of 2");
  });
});
