import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { reply } from "../ts";
import { rawRequest, rawStatus, withServer } from "./helpers";

/** Build a raw request head with `count` distinct `X-N: v` headers. */
function headWithHeaders(path: string, count: number): string {
  let head = `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n`;
  for (let i = 0; i < count; i += 1) {
    head += `X-Custom-${i}: v\r\n`;
  }
  return `${head}\r\n`;
}

describe("limits", () => {
  test("a body over maxBodyBytes is rejected with 413", async () => {
    const server = await withServer(
      (app) => {
        app.post("/echo", (req) => reply.text(req.text()));
      },
      { maxBodyBytes: 16 },
    );
    try {
      const res = await fetch(`${server.base}/echo`, { method: "POST", body: "x".repeat(64) });
      assert.equal(res.status, 413);
      assert.equal(await res.text(), "Payload Too Large");
    } finally {
      server.close();
    }
  });

  test("a body under maxBodyBytes is accepted", async () => {
    const server = await withServer(
      (app) => {
        app.post("/echo", (req) => reply.text(req.text()));
      },
      { maxBodyBytes: 64 },
    );
    try {
      const res = await fetch(`${server.base}/echo`, { method: "POST", body: "small" });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "small");
    } finally {
      server.close();
    }
  });

  test("more headers than maxHeaders is rejected with 400", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok"));
      },
      { maxHeaders: 8 },
    );
    try {
      // Well past the limit (Host + Connection + many X-Custom-*).
      const raw = await rawRequest(server.port, headWithHeaders("/", 30));
      assert.equal(rawStatus(raw), 400);
    } finally {
      server.close();
    }
  });

  test("a request under maxHeaders succeeds", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok"));
      },
      { maxHeaders: 32 },
    );
    try {
      const raw = await rawRequest(server.port, headWithHeaders("/", 4));
      assert.equal(rawStatus(raw), 200);
    } finally {
      server.close();
    }
  });

  test("a head larger than maxHeaderBytes is rejected with 400", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok"));
      },
      { maxHeaderBytes: 256 },
    );
    try {
      // One huge header value blows past the 256-byte head ceiling.
      const huge = `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(1024)}\r\nConnection: close\r\n\r\n`;
      const raw = await rawRequest(server.port, huge);
      assert.equal(rawStatus(raw), 400);
    } finally {
      server.close();
    }
  });

  test("a head under maxHeaderBytes succeeds", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok"));
      },
      { maxHeaderBytes: 4096 },
    );
    try {
      const raw = await rawRequest(
        server.port,
        "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      );
      assert.equal(rawStatus(raw), 200);
    } finally {
      server.close();
    }
  });
});
