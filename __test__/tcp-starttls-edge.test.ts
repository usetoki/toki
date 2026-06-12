import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// STARTTLS edge + security cases on ONE startTls server (the native engine is a singleton).
// The server begins each connection in cleartext, speaks a one-line negotiation, then upgrades
// in place via socket.upgradeTLS(); a toki connectTcp client drives the same dance from the
// other side. mTLS is enabled (requestCert + ca) so the server-side identity surface
// (authorized / peerCertificate / exportKeyingMaterial / alpnProtocol) can be asserted post-upgrade.
const dir = mkdtempSync(join(tmpdir(), "toki-starttls-"));
const p = (f: string): string => join(dir, f);
const sh = (a: string[]): void => {
  execFileSync("openssl", a, { stdio: "ignore" });
};
const HOST = "127.0.0.1";
const ALPN = "xmpp-client";

let caCert: Buffer;
let srvCert: Buffer, srvKey: Buffer;
let cliCert: Buffer, cliKey: Buffer;

try {
  // a real CA (cA=TRUE) the two sides trust.
  sh([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("ca.key"),
    "-out",
    p("ca.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=Toki STARTTLS CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  const caSign = (csr: string, out: string): void =>
    sh([
      "x509",
      "-req",
      "-in",
      p(csr),
      "-CA",
      p("ca.pem"),
      "-CAkey",
      p("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-out",
      p(out),
      "-copy_extensions",
      "copy",
    ]);

  // server leaf: CN=localhost with SANs so the client can verify it.
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("srv.key"),
    "-out",
    p("srv.csr"),
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  caSign("srv.csr", "srv.pem");

  // client leaf for mutual TLS.
  sh([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("cli.key"),
    "-out",
    p("cli.csr"),
    "-subj",
    "/CN=toki-client",
  ]);
  caSign("cli.csr", "cli.pem");

  caCert = readFileSync(p("ca.pem"));
  srvCert = readFileSync(p("srv.pem"));
  srvKey = readFileSync(p("srv.key"));
  cliCert = readFileSync(p("cli.pem"));
  cliKey = readFileSync(p("cli.key"));
} catch {
  console.log("skipped: openssl not available");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// per-connection server state we read back from the handler.
type SrvState = {
  authorized?: boolean;
  peerDer?: Buffer | undefined;
  exporter?: Buffer | undefined;
  alpn?: string | undefined;
};
let last: SrvState = {};

const server = createTcpServer(
  (sock: TcpSocket) => {
    let secure = false;
    let buf = ""; // cleartext line buffer; real STARTTLS protocols (SMTP/XMPP) are line/stanza based.
    // 'secure' fires synchronously the moment the upgrade establishes — before any post-upgrade
    // data — so the flag flips in time even when the client's Finished and first chunk coalesce.
    sock.on("secure", () => {
      secure = true;
      last = {
        authorized: sock.authorized,
        peerDer: sock.peerCertificate(),
        exporter: sock.exportKeyingMaterial(32, "L"),
        alpn: sock.alpnProtocol,
      };
    });
    sock.on("data", (c) => {
      if (secure) {
        sock.write(`enc:${c.toString()}`); // echoed only over the now-encrypted channel
        return;
      }
      // cleartext: parse whole `\n`-delimited lines so a pipelined burst is split deterministically
      // regardless of TCP segmentation. The FIRST STARTTLS line triggers the upgrade; any further
      // buffered cleartext is dropped here and, crucially, is NOT carried into the TLS read buffer.
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line === "STARTTLS") {
          sock.write("PROCEED");
          void sock.upgradeTLS().catch(() => {}); // uses the server's configured cert; opts ignored
        }
        // any other cleartext line (e.g. a smuggled "INJECTED") is consumed and discarded.
      }
    });
  },
  {
    tls: { cert: srvCert, key: srvKey, requestCert: true, ca: caCert, alpn: [ALPN] },
    startTls: true,
  },
);
const { port } = server.listen(0, HOST);
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function once<T = Buffer>(s: TcpSocket, ev: "data" | "secure"): Promise<T> {
  return new Promise((resolve) => {
    const h = (...a: unknown[]): void => {
      s.off(ev, h as never);
      resolve(a[0] as T);
    };
    s.on(ev as "data", h as never);
  });
}

// drive the cleartext negotiation up to PROCEED, returning the connected client.
async function startTls(): Promise<TcpSocket> {
  const c = await connectTcp(HOST, port, {});
  c.write("STARTTLS\n");
  assert.equal((await once<Buffer>(c, "data")).toString(), "PROCEED");
  return c;
}

const upgradeOpts = {
  servername: "localhost",
  ca: caCert,
  cert: cliCert,
  key: cliKey,
  alpn: [ALPN],
};

test("upgradeTLS() called twice on the same socket throws synchronously", async () => {
  const c = await startTls();
  await c.upgradeTLS(upgradeOpts);
  assert.equal(c.alpnProtocol, ALPN, "first upgrade negotiated ALPN");
  // a second upgrade on an already-TLS socket is a misuse: the native start returns false and
  // upgradeTLS throws synchronously (not a rejected promise). This also covers the conn.tls!=null
  // guard — there is no second cleartext session to upgrade.
  assert.throws(() => void c.upgradeTLS(upgradeOpts), /upgradeTLS could not start/);
  c.destroy();
});

test("post-upgrade the socket is indistinguishable from direct TLS (authorized, peerCert, exporter, ALPN)", async () => {
  const c = await startTls();
  await c.upgradeTLS(upgradeOpts);

  // client side: it verified the server cert and negotiated ALPN during the upgrade.
  assert.equal(c.authorized, true, "client verified the server cert");
  assert.equal(c.alpnProtocol, ALPN, "ALPN negotiated on the client");
  const cliExp = c.exportKeyingMaterial(32, "L");
  assert.ok(cliExp && cliExp.length === 32, "client exporter is 32 bytes");
  const cliPeer = c.peerCertificate();
  assert.ok(cliPeer && cliPeer.length > 0, "client holds the server's leaf DER");

  // server side: it requested + verified our client cert and recorded the same surface.
  // a probe-echo confirms the encrypted channel is live and the handler's 'secure' state ran.
  c.write("hi\n");
  assert.equal((await once<Buffer>(c, "data")).toString(), "enc:hi\n");
  assert.equal(last.authorized, true, "server authorized the client cert (mTLS)");
  assert.ok(last.peerDer && last.peerDer.length > 0, "server holds the client's leaf DER");
  assert.equal(last.alpn, ALPN, "server negotiated the same ALPN");
  assert.ok(last.exporter && last.exporter.length === 32, "server exporter is 32 bytes");
  // both ends derive identical keying material for the same label (RFC 8446 §7.5).
  assert.equal(
    last.exporter.toString("hex"),
    cliExp.toString("hex"),
    "exporter bytes match on both ends",
  );
  c.destroy();
});

test("pause()/resume() works on a STARTTLS-upgraded connection", async () => {
  const c = await startTls();
  await c.upgradeTLS(upgradeOpts);

  // pause the read side, ask the server to write, prove nothing arrives until resume.
  c.pause();
  let arrived = false;
  c.on("data", () => (arrived = true));
  c.write("paused\n");
  // give the server a turn to echo; a short unref'd timer bounds the "still paused" assertion.
  await new Promise<void>((r) => {
    const t = setTimeout(r, 150);
    t.unref();
  });
  assert.equal(arrived, false, "no data while paused");

  const got = once<Buffer>(c, "data");
  c.resume();
  assert.equal((await got).toString(), "enc:paused\n", "buffered bytes delivered after resume");
  c.destroy();
});

test("CVE-2011-0411: pre-upgrade plaintext is not replayed over the encrypted channel", async () => {
  // The classic STARTTLS injection: bytes buffered during cleartext must not be processed as if
  // they arrived inside the TLS session. The engine reads fresh into the TLS buffer at upgrade —
  // no plaintext is carried across — so a plaintext byte sent before PROCEED is never echoed back
  // over the encrypted channel (the handler only echoes once `secure` is set).
  const c = await connectTcp(HOST, port, {});
  // pipeline a smuggled plaintext command in the SAME cleartext burst as the negotiation, before
  // any upgrade is requested. Line-delimiting makes the split deterministic regardless of TCP
  // segmentation. A vulnerable STARTTLS would carry the buffered "INJECTED\n" into the TLS session
  // and process it as if it arrived encrypted; the engine instead reads fresh into the TLS buffer
  // at upgrade, so the trailing line is consumed as cleartext (discarded by the handler) and never
  // reappears over the encrypted channel.
  c.write("STARTTLS\nINJECTED\n");
  assert.equal((await once<Buffer>(c, "data")).toString(), "PROCEED");

  await c.upgradeTLS(upgradeOpts);
  // over the encrypted channel, only what we send post-upgrade is echoed back.
  const replayed: string[] = [];
  c.on("data", (d) => replayed.push(d.toString()));
  c.write("real\n");
  // wait for our own legitimate echo; if any smuggled plaintext were replayed it would appear too.
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (replayed.join("").includes("enc:real\n")) resolve();
    };
    c.on("data", tick);
    const t = setTimeout(resolve, 500);
    t.unref();
  });
  const joined = replayed.join("");
  assert.ok(joined.includes("enc:real\n"), "our post-TLS write is echoed");
  assert.equal(
    joined,
    "enc:real\n",
    "nothing but the post-TLS write is echoed (no plaintext replay of 'INJECTED')",
  );
  c.destroy();
});
