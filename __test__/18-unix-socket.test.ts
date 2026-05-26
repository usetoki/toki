import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { Toki, reply } from "../ts";
import type { ListenHandle } from "../ts";
import { unixFetch, uniqueSocketPath } from "./helpers";

// AF_UNIX HTTP is POSIX-only here; Windows named pipes are out of scope.
describe(
  "unix socket",
  { skip: process.platform === "win32" ? "no unix sockets on win32" : false },
  () => {
    let handle: ListenHandle;
    const socketPath = uniqueSocketPath();

    before(async () => {
      const app = new Toki();
      app.get("/", () => reply.text("over unix"));
      app.get("/whoami", (req) => reply.json({ transport: "unix", id: req.id }));
      handle = await app.listen({ port: 0, unixPath: socketPath });
    });

    after(async () => {
      handle.close();
      await rm(socketPath, { force: true });
    });

    test("reports port 0 for a unix-socket server", () => {
      assert.equal(handle.port, 0);
    });

    test("serves a plain response over the socket", async () => {
      const res = await unixFetch(socketPath, "/");
      assert.equal(res.status, 200);
      assert.equal(res.body, "over unix");
    });

    test("serves JSON with a request id over the socket", async () => {
      const res = await unixFetch(socketPath, "/whoami");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body) as { transport: string; id: string };
      assert.equal(body.transport, "unix");
      assert.match(body.id, /^[0-9a-f]{32}$/);
    });
  },
);
