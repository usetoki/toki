// run: node examples/tls.ts
//
// Direct HTTPS termination, no reverse proxy. Pass a PEM cert chain + private key
// (RSA or EC) as `tls` to `listen`, and toki terminates TLS 1.3 in the native engine.
// This mints a throwaway self-signed cert with openssl to stay self-contained; in
// production you'd load real cert/key files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, reply } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "toki-tls-"));
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
} catch {
  console.log("skipped: openssl not available to mint a demo certificate");
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const app = createApp({ logger: false });
app.get("/", () => reply.text("hello over https"));
app.get("/me", (req) => reply.json({ ip: req.ip }));

const cert = readFileSync(join(dir, "cert.pem"));
const key = readFileSync(join(dir, "key.pem"));
const handle = app.listen(0, { host: "127.0.0.1", tls: { cert, key } });

function get(path: string): Promise<{ status: number; body: string; tls: string | null }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port: handle.port, path, rejectUnauthorized: false },
      (res) => {
        const tls = (res.socket as { getProtocol?: () => string }).getProtocol?.() ?? null;
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, tls }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const root = await get("/");
assert.equal(root.status, 200);
assert.equal(root.body, "hello over https");
assert.equal(root.tls, "TLSv1.3"); // toki's server speaks TLS 1.3 only
console.log(`GET / over ${root.tls} -> ${root.body}`);

const me = await get("/me");
assert.equal(me.status, 200);
console.log("GET /me ->", me.body);

handle.close();
rmSync(dir, { recursive: true, force: true });
console.log("ok");
