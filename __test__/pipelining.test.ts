import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp, reply } from "../dist/index.js";
import { delay, freePort } from "./helpers.ts";

// node:http never pipelines, so these drive a raw socket to exercise the drain's
// cursor path: many complete requests delivered in a single write.
const app = createApp();
app.get("/a", () => reply.text("AAA"));
app.get("/b", () => reply.text("BBBB"));
app.get("/slow", async () => {
  await delay(40);
  return reply.text("SLOW");
});
app.post("/echo", (req) => reply.text(req.text()));

let port = 0;
let handle: { close: () => void };

before(async () => {
  port = await freePort();
  handle = app.listen(port, { host: "127.0.0.1" });
});
after(() => handle.close());

interface Resp {
  status: number;
  body: string;
}

// Collect exactly `expected` HTTP/1.1 responses (each with a Content-Length) sent over
// one connection, then resolve. Writes `chunks` with optional gaps between them.
function exchange(chunks: string[], expected: number, gapMs = 0): Promise<Resp[]> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    const out: Resp[] = [];
    const timer = setTimeout(
      () => reject(new Error(`got ${out.length}/${expected} responses`)),
      4000,
    );

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const headEnd = buf.indexOf("\r\n\r\n");
        if (headEnd === -1) break;
        const head = buf.subarray(0, headEnd).toString();
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
        const len = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0);
        const total = headEnd + 4 + len;
        if (buf.length < total) break;
        out.push({ status, body: buf.subarray(headEnd + 4, total).toString() });
        buf = buf.subarray(total);
        if (out.length === expected) {
          clearTimeout(timer);
          sock.end();
          resolve(out);
          return;
        }
      }
    });
    sock.on("error", reject);

    void (async () => {
      for (let i = 0; i < chunks.length; i++) {
        sock.write(chunks[i]!);
        if (gapMs && i < chunks.length - 1) await delay(gapMs);
      }
    })();
  });
}

const GET = (path: string): string => `GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`;

describe("http pipelining (single-write, multiple requests)", () => {
  test("two pipelined GETs return both responses in order", async () => {
    const r = await exchange([GET("/a") + GET("/b")], 2);
    assert.deepEqual(
      r.map((x) => x.body),
      ["AAA", "BBBB"],
    );
  });

  test("five pipelined GETs all respond in order", async () => {
    const r = await exchange([GET("/a") + GET("/b") + GET("/a") + GET("/b") + GET("/a")], 5);
    assert.deepEqual(
      r.map((x) => x.body),
      ["AAA", "BBBB", "AAA", "BBBB", "AAA"],
    );
  });

  test("an async handler pipelined before a sync one preserves order", async () => {
    const r = await exchange([GET("/slow") + GET("/a")], 2);
    assert.deepEqual(
      r.map((x) => x.body),
      ["SLOW", "AAA"],
    );
  });

  test("a pipelined POST body then a GET both parse correctly", async () => {
    const post = `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello`;
    const r = await exchange([post + GET("/a")], 2);
    assert.deepEqual(
      r.map((x) => x.body),
      ["hello", "AAA"],
    );
  });

  test("a request split across writes completes, with a pipelined successor", async () => {
    const first = GET("/a");
    const r = await exchange([first.slice(0, 12), first.slice(12) + GET("/b")], 2, 15);
    assert.deepEqual(
      r.map((x) => x.body),
      ["AAA", "BBBB"],
    );
  });

  test("a POST whose body arrives in a later write still echoes", async () => {
    const head = `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n\r\n`;
    const r = await exchange([head + "abc", "defg" + GET("/a")], 2, 15);
    assert.deepEqual(
      r.map((x) => x.body),
      ["abcdefg", "AAA"],
    );
  });

  test("HEAD on a GET route returns the GET Content-Length and no body", async () => {
    const head = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () =>
        sock.write("HEAD /a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      );
      let buf = "";
      sock.on("data", (d) => (buf += d));
      sock.on("close", () => resolve(buf));
      sock.on("error", reject);
    });
    assert.match(head, /^HTTP\/1\.1 200/);
    assert.match(head, /Content-Length: 3/); // body would be "AAA"
    assert.equal(head.split("\r\n\r\n")[1] ?? "", ""); // no body bytes
  });

  test("a Transfer-Encoding: chunked request is rejected with 400", async () => {
    // toki frames bodies by Content-Length only; accepting chunked would let the chunk
    // framing be read as body and open a TE-vs-CL request-smuggling desync
    const r = await exchange(
      [
        "POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
      ],
      1,
    );
    assert.equal(r[0]!.status, 400);
  });
});
