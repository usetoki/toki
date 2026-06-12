import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { connectTcp, createTcpServer, type TcpSocket } from "../ts/index.ts";

// SNI edge cases on one TLS server with an EC default cert and several sni: vhosts:
//  - an exact name beats an overlapping wildcard,
//  - a genuine no-SNI client gets the default and the server sees no name,
//  - an RSA sni cert (key algo != the EC default) is silently skipped at registration, so its
//    (non-wildcard) name falls back to the EC default and still completes a handshake.
// All registered sni certs share the default's key algorithm (EC), as the selector requires.
// connectTcp's client always sends SNI (defaulting to the host), and the vendored client verifies
// against DNS SANs not IP literals — so the default leaf's SAN names every fallback host, and the
// genuine no-SNI case is driven by a Node tls.connect with no servername.
const HOST = "127.0.0.1";
const dir = mkdtempSync(join(tmpdir(), "toki-sni-edge-"));
const p = (f: string): string => join(dir, f);
const sh = (a: string[]): void => {
  execFileSync("openssl", a, { stdio: "ignore" });
};

// distinct CAs per identity so a client trusting only one CA proves which cert was served.
let defCert: Buffer, defKey: Buffer; // EC default, CN=localhost
let defCa: Buffer;
let exactCert: Buffer, exactKey: Buffer; // EC, CN=host.example.com
let exactCa: Buffer;
let wildCert: Buffer, wildKey: Buffer; // EC, CN=*.example.com
let wildCa: Buffer;
let rsaCert: Buffer, rsaKey: Buffer; // RSA (mismatched algo), CN=rsa.test
let exactDer: Buffer, wildDer: Buffer; // leaf DER, to tell exact from wildcard on the client

try {
  // an EC (or RSA, when `curve` is empty) leaf signed by its own throwaway CA, with a SAN.
  // openssl x509 -extfile reads the SAN/basicConstraints from stdin each call.
  const mintSan = (name: string, cn: string, san: string, curve: string): void => {
    const cfg = `[v3]\nsubjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\n`;
    const caKeyArgs = curve ? ["ec", "-pkeyopt", `ec_paramgen_curve:${curve}`] : ["rsa:2048"];
    sh([
      "req",
      "-x509",
      "-newkey",
      ...caKeyArgs,
      "-nodes",
      "-keyout",
      p(`${name}-ca.key`),
      "-out",
      p(`${name}-ca.pem`),
      "-days",
      "1",
      "-subj",
      `/CN=${cn} CA`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    sh([
      "req",
      "-newkey",
      ...caKeyArgs,
      "-nodes",
      "-keyout",
      p(`${name}.key`),
      "-out",
      p(`${name}.csr`),
      "-subj",
      `/CN=${cn}`,
    ]);
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        p(`${name}.csr`),
        "-CA",
        p(`${name}-ca.pem`),
        "-CAkey",
        p(`${name}-ca.key`),
        "-CAcreateserial",
        "-days",
        "1",
        "-out",
        p(`${name}.pem`),
        "-extfile",
        "/dev/stdin",
        "-extensions",
        "v3",
      ],
      { input: cfg, stdio: ["pipe", "ignore", "ignore"] },
    );
  };

  const P256 = "prime256v1";
  // the default leaf names "localhost" (the no-SNI Node client's verify name) and "rsa.test" (the
  // connectTcp verify name when the RSA entry is skipped and the default answers instead).
  mintSan("def", "localhost", "DNS:localhost,DNS:rsa.test", P256);
  mintSan("exact", "host.example.com", "DNS:host.example.com", P256);
  mintSan("wild", "*.example.com", "DNS:*.example.com", P256);
  // RSA (mismatched key algo) under a name no wildcard covers, so its only fallback is the default.
  mintSan("rsa", "rsa.test", "DNS:rsa.test", "");

  defCert = readFileSync(p("def.pem"));
  defKey = readFileSync(p("def.key"));
  defCa = readFileSync(p("def-ca.pem"));
  exactCert = readFileSync(p("exact.pem"));
  exactKey = readFileSync(p("exact.key"));
  exactCa = readFileSync(p("exact-ca.pem"));
  wildCert = readFileSync(p("wild.pem"));
  wildKey = readFileSync(p("wild.key"));
  wildCa = readFileSync(p("wild-ca.pem"));
  rsaCert = readFileSync(p("rsa.pem"));
  rsaKey = readFileSync(p("rsa.key"));
  exactDer = new crypto.X509Certificate(exactCert).raw;
  wildDer = new crypto.X509Certificate(wildCert).raw;
} catch {
  console.log("skipped: openssl not available");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// the handler echoes the requested SNI name so the server side can be inspected.
const server = createTcpServer(
  (sock: TcpSocket) => {
    sock.write(`${sock.servername ?? "none"}\n`);
  },
  {
    tls: {
      cert: defCert,
      key: defKey,
      sni: [
        // both overlap "host.example.com"; the exact entry must win.
        { servername: "host.example.com", cert: exactCert, key: exactKey },
        { servername: "*.example.com", cert: wildCert, key: wildKey },
        // RSA while the default is EC: must be skipped at registration, not served.
        { servername: "rsa.test", cert: rsaCert, key: rsaKey },
      ],
    },
  },
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

test("an exact SNI name beats an overlapping wildcard", async () => {
  // "host.example.com" matches both the exact entry and "*.example.com"; trusting only the exact
  // CA, the handshake succeeds only if the exact cert was served — and the leaf DER confirms it.
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "host.example.com", ca: exactCa },
  });
  assert.equal(sock.authorized, true, "the exact certificate verified (the wildcard would not)");
  const der = sock.peerCertificate();
  assert.ok(der, "the server presented a leaf certificate");
  assert.ok(der.equals(exactDer), "it is the exact cert, not the wildcard");
  assert.ok(!der.equals(wildDer), "and definitely not the wildcard cert");
  assert.equal(await line(sock), "host.example.com", "the server saw the requested name");
  sock.destroy();
});

test("the wildcard still serves a sibling name it alone matches", async () => {
  // a name only the wildcard covers proves the wildcard entry is live and distinct from the exact.
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "other.example.com", ca: wildCa },
  });
  assert.equal(sock.authorized, true, "the wildcard certificate verified for other.example.com");
  const der = sock.peerCertificate();
  assert.ok(der?.equals(wildDer), "the wildcard cert was served");
  assert.equal(await line(sock), "other.example.com");
  sock.destroy();
});

test("a genuine no-SNI client gets the default cert and the server sees no name", async () => {
  // connectTcp always sends SNI, so a true no-SNI client is a Node tls.connect with no servername.
  // Trusting only the default CA, the handshake completes iff the default cert was served; the
  // server's servername is then undefined (echoed as "none").
  // What's under test is the SNI selection (no name -> default cert), not whether Node's OpenSSL
  // trusts the chain — so don't gate on verification (macOS mints with LibreSSL, whose EC leaves
  // Node's bundled OpenSSL won't always chain). Assert the SERVED cert identity and the server's
  // view of the name instead; the exact/wildcard cases above already prove toki-side trust.
  const c = tls.connect({
    port,
    host: HOST,
    rejectUnauthorized: false,
    minVersion: "TLSv1.3",
  });
  const seen = await new Promise<string>((resolve, reject) => {
    let buf = "";
    c.once("error", reject);
    c.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) resolve(buf.trim());
    });
  });
  assert.equal(c.getPeerCertificate().subject.CN, "localhost", "the EC default cert was served");
  assert.equal(seen, "none", "the server saw no requested host name");
  c.destroy();
});

test("an RSA sni cert is skipped at registration; its name falls back to the EC default", async () => {
  // the RSA entry shares no key algo with the EC default, so it must be dropped at registration.
  // "rsa.test" matches no wildcard, so the only fallback is the default. Requesting it must NOT
  // break the handshake: trusting only the default (EC) CA proves the default — not the RSA cert,
  // and not any vhost — answered.
  const sock = await connectTcp("127.0.0.1", port, {
    tls: { servername: "rsa.test", ca: defCa },
  });
  assert.equal(sock.authorized, true, "the EC default served the RSA name — handshake intact");
  const der = sock.peerCertificate();
  assert.ok(der, "a leaf certificate was presented");
  assert.ok(
    !der.equals(new crypto.X509Certificate(rsaCert).raw),
    "the RSA cert was not served (it was skipped at registration)",
  );
  // the server still reads the requested name off the ClientHello even though it served the default.
  assert.equal(await line(sock), "rsa.test", "the server saw the requested name");
  sock.destroy();
});
