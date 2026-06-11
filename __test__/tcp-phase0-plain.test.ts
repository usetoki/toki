import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { createTcpServer, type CloseReason, type TcpSocket } from "../ts/index.ts";

// Phase 0 on a plaintext socket: flush-aware end(), write-after-close → false, close reasons.
// One server per process; the first line picks the behaviour.
type ServerInfo = { reason: CloseReason } & Record<string, unknown>;
const pending = new Map<string, (info: ServerInfo) => void>();

const server = createTcpServer((socket) => {
  let mode = "";
  let token = "";
  const rec: Record<string, unknown> = {};

  socket.on("close", (reason) => {
    if (mode === "wac") rec.lateWrite = socket.write("late");
    pending.get(token)?.({ reason, ...rec });
  });
  socket.on("end", () => {
    rec.gotEnd = true; // peer half-closed (FIN)
  });
  socket.on("data", (chunk) => {
    if (mode !== "") return;
    const nl = chunk.indexOf(0x0a);
    const line = (nl === -1 ? chunk : chunk.subarray(0, nl)).toString();
    [mode, token] = line.split(" ") as [string, string];
    run(socket, mode, rec);
  });

  function run(s: TcpSocket, m: string, r: Record<string, unknown>): void {
    switch (m) {
      case "bigend":
        s.write(Buffer.alloc(4 * 1024 * 1024, 0x61));
        s.end();
        return;
      case "idleend":
        s.end("hi");
        return;
      case "endthenwrite":
        s.end();
        r.afterEnd = s.write("nope");
        return;
      case "destroyme":
        s.write("hi");
        s.destroy();
        return;
      case "overflow":
        s.write(Buffer.alloc(24 * 1024 * 1024, 0x62));
        return;
      case "wac":
        s.write("k");
        return;
      case "halfclose":
        // peer FINs; with allowHalfOpen off the engine auto-ends our side cleanly
        return;
    }
  }
});
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

let nextToken = 0;

function drive<T>(
  mode: string,
  client: (s: net.Socket, done: (v: T) => void) => void,
): Promise<{ server: ServerInfo; client: T }> {
  return new Promise((resolve, reject) => {
    const token = String(nextToken++);
    let serverInfo: ServerInfo | undefined;
    let clientInfo: T | undefined;
    const settle = () => {
      if (serverInfo !== undefined && clientInfo !== undefined)
        resolve({ server: serverInfo, client: clientInfo });
    };
    pending.set(token, (info) => {
      serverInfo = info;
      settle();
    });
    let connected = false;
    const s = net.connect(port, "127.0.0.1", () => {
      connected = true;
      s.write(`${mode} ${token}\n`);
      client(s, (v) => {
        clientInfo = v;
        settle();
      });
    });
    // post-connect errors (an expected ECONNRESET in the RST tests) are the test's to handle;
    // only a connect-time failure rejects the harness.
    s.on("error", (e) => {
      if (!connected) reject(e);
    });
  });
}

function readToClose(s: net.Socket, done: (v: { body: Buffer; clean: boolean }) => void): void {
  const chunks: Buffer[] = [];
  let errored = false;
  s.on("data", (c) => chunks.push(c));
  s.on("error", () => (errored = true));
  s.on("close", (hadError) => done({ body: Buffer.concat(chunks), clean: !errored && !hadError }));
}

test("0a: plaintext end() under backlog delivers every byte then a clean FIN", async () => {
  const out = await drive("bigend", readToClose);
  assert.equal(out.client.body.length, 4 * 1024 * 1024);
  assert.ok(out.client.body.every((b) => b === 0x61));
  assert.ok(out.client.clean, "clean FIN, no RST");
});

test("0a: plaintext end(data) flushes the final chunk", async () => {
  const out = await drive("idleend", readToClose);
  assert.equal(out.client.body.toString(), "hi");
  assert.ok(out.client.clean);
  assert.equal(out.server.reason, "normal");
});

test("0b: plaintext write() after end() returns false", async () => {
  const out = await drive("endthenwrite", readToClose);
  assert.equal(out.server.afterEnd, false);
});

test("0b: plaintext write() after the socket is gone returns false", async () => {
  const out = await drive<true>("wac", (s, done) => {
    s.once("data", () => s.resetAndDestroy());
    s.on("close", () => done(true));
  });
  assert.equal(out.server.lateWrite, false);
});

test("0c: plaintext blowing the write-queue cap reports 'write-queue-overflow'", async () => {
  const out = await drive<true>("overflow", (s, done) => {
    s.pause();
    s.on("error", () => {});
    done(true);
  });
  assert.equal(out.server.reason, "write-queue-overflow");
});

test("0c: plaintext destroy() resets the peer and reports reason 'normal'", async () => {
  const out = await drive<{ reset: boolean }>("destroyme", (s, done) => {
    let reset = false;
    s.on("data", () => {});
    s.on("error", (e: NodeJS.ErrnoException) => (reset = e.code === "ECONNRESET"));
    s.on("close", () => done({ reset }));
  });
  assert.ok(out.client.reset, "peer sees a reset");
  assert.equal(out.server.reason, "normal");
});

test("peer half-close (FIN) surfaces as 'end' and the engine auto-closes cleanly", async () => {
  const out = await drive<{ clean: boolean }>("halfclose", (s, done) => {
    let errored = false;
    s.on("data", () => {});
    s.end(); // client half-closes; server sees 'end', auto-ends back
    s.on("error", () => (errored = true));
    s.on("close", (hadError) => done({ clean: !errored && !hadError }));
  });
  assert.equal(out.server.gotEnd, true, "the server saw the peer's FIN as 'end'");
  assert.equal(out.server.reason, "normal");
  assert.ok(out.client.clean);
});
