import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// RFC 8446 §7.5 keying-material exporter (RFC 9266 `tls-exporter` channel binding). Node's own
// tls.exportKeyingMaterial is OpenSSL-backed, so it's the reference: toki must derive byte-for-byte
// the same material as a Node peer on the same session — that interop is what makes channel binding
// usable against any other stack. One toki TLS server (the engine is a singleton); the peers on the
// other side are Node tls sockets, plus a Node tls server for the toki-client direction.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));

const LABEL = "EXPORTER-toki-test";
const CTX = Buffer.from("channel-binding-context");

// toki TLS server: on the first byte, reply with its exporter values (no-context and with-context).
const server = createTcpServer(
  (sock) => {
    sock.on("data", () => {
      const a = sock.exportKeyingMaterial(32, LABEL);
      const b = sock.exportKeyingMaterial(48, LABEL, CTX);
      sock.write(`${a?.toString("hex")} ${b?.toString("hex")}\n`);
    });
  },
  { tls: { cert, key } },
);
const { port } = server.listen(0, "127.0.0.1");

// a Node tls server for the toki-client direction; replies with its own exporter values.
const nodeTls = tls.createServer({ cert, key }, (s) => {
  s.on("data", () => {
    const a = s.exportKeyingMaterial(32, LABEL, Buffer.alloc(0)).toString("hex");
    const b = s.exportKeyingMaterial(48, LABEL, CTX).toString("hex");
    s.write(`${a} ${b}\n`);
  });
});
nodeTls.listen(0, "127.0.0.1");
const nodeTlsPort = () => (nodeTls.address() as net.AddressInfo).port;

// a plaintext server for the "no exporter on a plaintext socket" case.
const plain = net.createServer((s) => {
  s.on("error", () => {});
  s.on("data", () => s.write("hi"));
});
plain.listen(0, "127.0.0.1");
const plainPort = () => (plain.address() as net.AddressInfo).port;

after(() => {
  server.close();
  nodeTls.close();
  plain.close();
});

function line(sock: TcpSocket): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) resolve(buf.slice(0, nl));
    });
  });
}

test("toki server and a Node client derive identical exporter material (interop)", async () => {
  const c = tls.connect({
    port,
    host: "127.0.0.1",
    servername: "localhost",
    ca: cert,
    minVersion: "TLSv1.3",
  });
  await new Promise<void>((res, rej) => {
    c.once("secureConnect", res);
    c.once("error", rej);
  });
  const nodeNoCtx = c.exportKeyingMaterial(32, LABEL, Buffer.alloc(0)).toString("hex");
  const nodeCtx = c.exportKeyingMaterial(48, LABEL, CTX).toString("hex");
  c.write("go");
  const [tokiNoCtx, tokiCtx] = await new Promise<string[]>((res) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) res(buf.trim().split(" "));
    });
  });
  assert.equal(tokiNoCtx, nodeNoCtx, "no-context exporter matches OpenSSL");
  assert.equal(tokiCtx, nodeCtx, "with-context exporter matches OpenSSL");
  c.destroy();
});

test("a toki client and a Node server derive identical exporter material (interop)", async () => {
  const sock = await connectTcp("127.0.0.1", nodeTlsPort(), {
    tls: { servername: "localhost", ca: cert },
  });
  const tokiNoCtx = sock.exportKeyingMaterial(32, LABEL)!.toString("hex");
  const tokiCtx = sock.exportKeyingMaterial(48, LABEL, CTX)!.toString("hex");
  sock.write("go");
  const [nodeNoCtx, nodeCtx] = (await line(sock)).split(" ");
  assert.equal(tokiNoCtx, nodeNoCtx);
  assert.equal(tokiCtx, nodeCtx);
  sock.destroy();
});

test("both ends of a toki<->toki session export the same bytes (channel binding)", async () => {
  const c = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  const mineNoCtx = c.exportKeyingMaterial(32, LABEL)!.toString("hex");
  const mineCtx = c.exportKeyingMaterial(48, LABEL, CTX)!.toString("hex");
  c.write("go");
  const [srvNoCtx, srvCtx] = (await line(c)).split(" ");
  assert.equal(mineNoCtx, srvNoCtx);
  assert.equal(mineCtx, srvCtx);
  c.destroy();
});

test("the context and label change the output; the length is honoured", async () => {
  const c = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  const base = c.exportKeyingMaterial(32, LABEL)!;
  const withCtx = c.exportKeyingMaterial(32, LABEL, CTX)!;
  const otherLabel = c.exportKeyingMaterial(32, "OTHER-LABEL")!;
  assert.equal(base.length, 32, "requested length honoured");
  assert.notEqual(base.toString("hex"), withCtx.toString("hex"), "context changes the material");
  assert.notEqual(base.toString("hex"), otherLabel.toString("hex"), "label changes the material");
  assert.equal(c.exportKeyingMaterial(48, LABEL)!.length, 48);
  c.destroy();
});

test("a label at the RFC length boundary works; an over-long or empty label is rejected without crashing", async () => {
  const c = await connectTcp("127.0.0.1", port, { tls: { servername: "localhost", ca: cert } });
  // the HkdfLabel length prefix is len("tls13 ") + label = 6 + label in a single byte, so 249 is
  // the largest label that fits (6 + 249 = 255). 250 would wrap the prefix — it must be rejected,
  // not derived and not panic the process (the safety build would otherwise abort here).
  const max = c.exportKeyingMaterial(32, "A".repeat(249));
  assert.ok(max && max.length === 32, "a 249-byte label derives normally");
  assert.equal(
    c.exportKeyingMaterial(32, "A".repeat(250)),
    undefined,
    "a 250-byte label is rejected",
  );
  assert.equal(
    c.exportKeyingMaterial(32, "A".repeat(4096)),
    undefined,
    "a far-too-long label is rejected",
  );
  assert.equal(c.exportKeyingMaterial(32, ""), undefined, "an empty label is rejected");
  // still usable afterwards — the rejections didn't corrupt the session
  assert.equal(c.exportKeyingMaterial(32, LABEL)!.length, 32);
  c.destroy();
});

test("exportKeyingMaterial is undefined on a plaintext connection", async () => {
  const sock = await connectTcp("127.0.0.1", plainPort(), {});
  assert.equal(sock.exportKeyingMaterial(32, LABEL), undefined);
  sock.destroy();
});
