import assert from "node:assert/strict";
import { connect as netConnect } from "node:net";
import { after, test } from "node:test";
import { createApp, reply } from "../dist/index.js";
import { certFixture, makeHttps } from "./tls-helpers.ts";

const cert = certFixture("rsa-cert.pem");
const key = certFixture("rsa-key.pem");

const app = createApp({ logger: false });
app.get("/", () => reply.text("rsa ok"));

const handle = app.listen(0, { host: "127.0.0.1", tls: { cert, key } });
const port = handle.port;
const https = makeHttps(port);
after(() => handle.close());

test("an RSA server certificate completes the handshake", async () => {
  const r = await https({ path: "/" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "rsa ok");
});

test("plaintext HTTP to the HTTPS port is rejected without crashing the server", async () => {
  await new Promise<void>((resolve) => {
    const sock = netConnect(port, "127.0.0.1", () => {
      sock.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"); // garbage as a ClientHello
    });
    const done = (): void => resolve();
    sock.on("error", done);
    sock.on("close", done);
    sock.setTimeout(2000, () => {
      sock.destroy();
      resolve();
    });
  });
  // server must still be alive and serving valid TLS
  const r = await https({ path: "/" });
  assert.equal(r.status, 200);
});

test("abrupt disconnects mid-handshake don't crash or leak", async () => {
  for (let i = 0; i < 25; i++) {
    await new Promise<void>((resolve) => {
      const sock = netConnect(port, "127.0.0.1", () => {
        // start of a TLS handshake record, then vanish
        sock.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x20, 0x01, 0x00, 0x00]));
        sock.destroy();
      });
      sock.on("error", () => resolve());
      sock.on("close", () => resolve());
    });
  }
  const r = await https({ path: "/" });
  assert.equal(r.status, 200);
});
