import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import { after, test } from "node:test";
import { createApp, reply } from "../dist/index.js";

// unix-domain sockets are a POSIX feature here; Windows maps them to named pipes.
const skip = process.platform === "win32";
const sock = `/tmp/toki-unix-${process.pid}.sock`;

const app = createApp();
app.get("/", () => reply.text("over unix"));
app.get("/ip", (req) => reply.json({ ip: req.ip }));
app.post("/echo", (req) => reply.text(req.text()));

const handle = app.listen(0, { unixPath: sock });
after(() => handle.close());

function request(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  const headers = body === undefined ? {} : { "content-length": Buffer.byteLength(body) };
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("binding a unix socket creates the socket file", { skip }, () => {
  assert.ok(existsSync(sock), "socket file should exist after listen");
});

test("serves a GET over the unix socket", { skip }, async () => {
  const r = await request("GET", "/");
  assert.equal(r.status, 200);
  assert.equal(r.body, "over unix");
});

test("a POST body round-trips over the unix socket", { skip }, async () => {
  const r = await request("POST", "/echo", "hello-unix");
  assert.equal(r.body, "hello-unix");
});

test("req.ip is empty for a unix connection (no peer address)", { skip }, async () => {
  const r = await request("GET", "/ip");
  assert.deepEqual(JSON.parse(r.body), { ip: "" });
});

test("many concurrent requests over the unix socket all succeed", { skip }, async () => {
  const results = await Promise.all(Array.from({ length: 40 }, () => request("GET", "/")));
  assert.ok(results.every((r) => r.status === 200 && r.body === "over unix"));
});
