import assert from "node:assert/strict";
import { request } from "node:https";
import { after, before, describe, test } from "node:test";

import { reply } from "../ts";
import {
  generateSelfSignedCert,
  withServer,
  type RunningServer,
  type SelfSignedCert,
} from "./helpers";

// Per-request `rejectUnauthorized: false` keeps verification disabled to this
// connection only — no global NODE_TLS_REJECT_UNAUTHORIZED, no process warning.
function httpsGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", rejectUnauthorized: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const cert = generateSelfSignedCert();

describe("tls (https)", { skip: cert === null ? "openssl unavailable" : false }, () => {
  const tls = cert as SelfSignedCert;
  let server: RunningServer;

  before(async () => {
    server = await withServer(
      (app) => {
        app.get("/", () => reply.text("secure ok"));
        app.get("/whoami", (req) => reply.json({ secure: true, id: req.id }));
      },
      { tlsCert: tls.cert, tlsKey: tls.key },
    );
  });

  after(() => {
    server.close();
    tls.cleanup();
  });

  test("serves a plain response over HTTPS", async () => {
    const res = await httpsGet(server.port, "/");
    assert.equal(res.status, 200);
    assert.equal(res.body, "secure ok");
  });

  test("serves JSON with a request id over HTTPS", async () => {
    const res = await httpsGet(server.port, "/whoami");
    const body = JSON.parse(res.body) as { secure: boolean; id: string };
    assert.equal(body.secure, true);
    assert.match(body.id, /^[0-9a-f]{32}$/);
  });
});
