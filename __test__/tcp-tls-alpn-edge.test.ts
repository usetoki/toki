import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// ALPN absence: a server with NO alpn list configured must send NO ALPN extension at all (RFC 7301),
// not silently default to "http/1.1". Both a Node tls client and a toki connectTcp client then see
// "nothing negotiated" — false on Node's socket, undefined on toki's. The server keeps this file to a
// single TLS config (one native server per process); the with-alpn negotiation lives in tcp-tls-alpn.
const HOST = "127.0.0.1";
const dir = mkdtempSync(join(tmpdir(), "toki-alpn-edge-"));
const p = (f: string): string => join(dir, f);

let cert: Buffer, key: Buffer;
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      p("srv.key"),
      "-out",
      p("srv.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(p("srv.pem"));
  key = readFileSync(p("srv.key"));
} catch {
  console.log("skipped: openssl not available");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// the server has tls but no alpn — it echoes what it thinks was negotiated so we can prove "none".
const server = createTcpServer(
  (sock: TcpSocket) => {
    sock.write(`${sock.alpnProtocol ?? "none"}\n`);
  },
  { tls: { cert, key } },
);
const { port } = server.listen(0, HOST);

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function line(sock: TcpSocket): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      if (buf.includes("\n")) resolve(buf.trim());
    });
  });
}

test("a Node client offering http/1.1 gets no protocol — the server advertised none", async () => {
  const c = tls.connect({
    port,
    host: HOST,
    servername: "localhost",
    ca: cert,
    minVersion: "TLSv1.3",
    ALPNProtocols: ["http/1.1"],
  });
  await new Promise<void>((res, rej) => {
    c.once("secureConnect", res);
    c.once("error", rej);
  });
  // Node reports `false` when nothing was negotiated — it must NOT be "http/1.1".
  assert.equal(c.alpnProtocol, false, "no ALPN extension from the server, so none negotiated");
  c.destroy();
});

test("a toki client offering h2 sees alpnProtocol undefined against the no-alpn server", async () => {
  const sock = await connectTcp(HOST, port, {
    tls: { servername: "localhost", ca: cert, alpn: ["h2"] },
  });
  assert.equal(sock.alpnProtocol, undefined, "the server offered nothing, so none negotiated");
  assert.equal(await line(sock), "none", "the server side agrees nothing was negotiated");
  sock.destroy();
});

test("a toki client offering no ALPN handshakes fine, undefined protocol", async () => {
  const sock = await connectTcp(HOST, port, { tls: { servername: "localhost", ca: cert } });
  assert.equal(sock.alpnProtocol, undefined);
  assert.equal(await line(sock), "none");
  sock.destroy();
});
