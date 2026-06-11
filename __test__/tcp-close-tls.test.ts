import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { createTcpServer, type CloseReason, type TcpSocket } from "../ts/index.ts";

// Close and shutdown semantics on the raw TLS socket: flush-aware end() (every byte delivered
// then a clean close_notify + FIN, no truncating reset), write() after close reporting false,
// the close reason on ev_close, and the edge cases around them. One TLS server per process;
// each connection picks a behaviour with its first line.
const here = dirname(fileURLToPath(import.meta.url));
const cert = readFileSync(join(here, "fixtures", "ec-cert.pem"));
const key = readFileSync(join(here, "fixtures", "ec-key.pem"));

// the server records whatever the in-flight test needs to learn, plus the close reason.
// connections are correlated by a token in the first line, so tests can run concurrently.
type ServerInfo = { reason: CloseReason } & Record<string, unknown>;
const pending = new Map<string, (info: ServerInfo) => void>();

const server = createTcpServer(
  (socket) => {
    let mode = "";
    let token = "";
    const rec: Record<string, unknown> = {};

    socket.on("close", (reason) => {
      if (mode === "wac") rec.lateWrite = socket.write("late");
      pending.get(token)?.({ reason, ...rec });
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
        case "hugeend":
          // 12 MiB — under the 16 MiB cap, so it drains fully across many turns before the FIN
          s.write(Buffer.alloc(12 * 1024 * 1024, 0x64));
          s.end();
          return;
        case "idleend":
          s.write("hi");
          s.end();
          return;
        case "enddata":
          s.write("a");
          s.end("b"); // final chunk via end(data)
          return;
        case "endtwice":
          s.write("hi");
          s.end();
          s.end(); // idempotent, no crash
          return;
        case "endthenwrite":
          s.end();
          r.afterEnd = s.write("nope"); // write after end() must report false
          return;
        case "destroyme":
          s.write("hi");
          s.destroy();
          return;
        case "overflow":
          s.write(Buffer.alloc(24 * 1024 * 1024, 0x62));
          return;
        case "wac":
          s.write("k"); // ack: the client closes only after the mode is in, so close sees "wac"
          return;
        case "peerreset":
          s.write(Buffer.alloc(64 * 1024, 0x63)); // unread data so the peer's destroy() RSTs
          return;
      }
    }
  },
  { tls: { cert, key } },
);
const { port } = server.listen(0, "127.0.0.1");
after(() => server.close());

let nextToken = 0;

function drive<T>(
  mode: string,
  client: (s: tls.TLSSocket, done: (v: T) => void) => void,
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
    const s = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
      connected = true;
      s.write(`${mode} ${token}\n`);
      client(s, (v) => {
        clientInfo = v;
        settle();
      });
    });
    s.on("error", (e) => {
      if (!connected) reject(e); // only a connect/handshake failure rejects
    });
  });
}

// collect every byte and report whether the TLS close was clean (close_notify + FIN, no RST)
function readToClose(s: tls.TLSSocket, done: (v: { body: Buffer; clean: boolean }) => void): void {
  const chunks: Buffer[] = [];
  let errored = false;
  s.on("data", (c) => chunks.push(c));
  s.on("error", () => (errored = true));
  s.on("close", (hadError) => done({ body: Buffer.concat(chunks), clean: !errored && !hadError }));
}

test("end() under write backlog delivers every byte then a clean TLS close", async () => {
  const out = await drive("bigend", readToClose);
  assert.equal(out.client.body.length, 4 * 1024 * 1024);
  assert.ok(out.client.clean, "no truncating RST");
});

test("a 12 MiB backlog drains fully before the FIN", async () => {
  const out = await drive("hugeend", readToClose);
  assert.equal(out.client.body.length, 12 * 1024 * 1024);
  assert.ok(
    out.client.body.every((b) => b === 0x64),
    "no corruption across the drain",
  );
  assert.ok(out.client.clean);
});

test("end() on an idle connection closes promptly and cleanly", async () => {
  const out = await drive("idleend", readToClose);
  assert.equal(out.client.body.toString(), "hi");
  assert.ok(out.client.clean);
});

test("end(data) flushes the final chunk then closes cleanly", async () => {
  const out = await drive("enddata", readToClose);
  assert.equal(out.client.body.toString(), "ab");
  assert.ok(out.client.clean);
});

test("end() twice is a no-op (one clean close)", async () => {
  const out = await drive("endtwice", readToClose);
  assert.equal(out.client.body.toString(), "hi");
  assert.ok(out.client.clean);
  assert.equal(out.server.reason, "normal");
});

test("write() after end() returns false", async () => {
  const out = await drive("endthenwrite", readToClose);
  assert.equal(out.server.afterEnd, false);
});

test("write() after the socket is gone returns false, not a bogus flush", async () => {
  const out = await drive<true>("wac", (s, done) => {
    s.once("data", () => s.destroy()); // close only after the server acked the mode
    s.on("close", () => done(true));
  });
  assert.equal(out.server.lateWrite, false);
});

test("a clean end() reports reason 'normal'", async () => {
  const out = await drive("idleend", readToClose);
  assert.equal(out.server.reason, "normal");
});

test("destroy() reports reason 'normal' (app-initiated)", async () => {
  const out = await drive<true>("destroyme", (s, done) => {
    s.on("data", () => {});
    s.on("error", () => {});
    s.on("close", () => done(true));
  });
  assert.equal(out.server.reason, "normal");
});

// see the plaintext suite: Windows socket-buffer sizing makes the cap trigger nondeterministic.
test(
  "blowing the write-queue cap reports 'write-queue-overflow'",
  { skip: process.platform === "win32" },
  async () => {
    const out = await drive<true>("overflow", (s, done) => {
      s.pause(); // never read; keep the socket alive to apply backpressure past the cap
      s.on("error", () => {});
      done(true);
    });
    assert.equal(out.server.reason, "write-queue-overflow");
  },
);

test("a peer RST mid-session reports 'peer-reset'", async () => {
  const out = await drive<true>("peerreset", (s, done) => {
    s.once("data", () => s.destroy()); // close without close_notify while bytes are unread
    s.on("error", () => {});
    s.on("close", () => done(true));
  });
  assert.equal(out.server.reason, "peer-reset");
});

test("many connections end under backlog concurrently with no cross-talk", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => drive("bigend", readToClose)));
  for (const out of results) {
    assert.equal(out.client.body.length, 4 * 1024 * 1024);
    assert.ok(
      out.client.body.every((b) => b === 0x61),
      "each stream is its own bytes",
    );
    assert.ok(out.client.clean);
  }
});
