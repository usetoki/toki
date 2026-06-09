// Bind a unix-domain socket instead of TCP — handy behind a same-host reverse proxy.
// run: node examples/unix-socket.ts
import assert from "node:assert/strict";
import http from "node:http";
import { createApp, reply } from "../ts/index.ts";

const socketPath = `/tmp/toki-example-${process.pid}.sock`;

const app = createApp();
app.get("/", () => reply.text("served over a unix socket"));

const server = app.listen(0, { unixPath: socketPath });

function get(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  assert.equal(await get("/"), "served over a unix socket");
  server.close();
  console.log("unix-socket example OK");
  process.exit(0);
}

main();
