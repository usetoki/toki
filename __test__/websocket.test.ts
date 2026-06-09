import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "../dist/index.js";
import { freePort } from "./helpers.ts";

// ---------------------------------------------------------------------------
// server under test
// ---------------------------------------------------------------------------

// One app per process: the native engine holds global server state. The 512 KiB
// message cap lets the large-message test through; the 600 KiB oversize test trips
// the 1009 path.
const MAX_WS_MESSAGE = 512 * 1024;

const app = createApp();
app.ws("/echo", (socket) => {
  socket.on("message", (data, isBinary) => {
    socket.send(isBinary ? new Uint8Array(data) : data.toString());
  });
  socket.on("ping", () => socket.send("got-ping"));
});
app.ws("/chat", { protocols: ["chat", "superchat"] }, (socket) => {
  socket.send(`protocol:${socket.protocol}`);
});
app.ws("/push", (socket) => {
  socket.send("welcome");
  socket.close(1000);
});
app.ws("/closer", (socket) => {
  socket.on("message", () => socket.close(4001));
});

let port = 0;
let handle: { close: () => void };

before(async () => {
  port = await freePort();
  handle = app.listen(port, { host: "127.0.0.1", maxWsMessageBytes: MAX_WS_MESSAGE });
});
after(() => {
  handle.close();
});

// ---------------------------------------------------------------------------
// happy path — Node's built-in WebSocket client (handles masking/framing)
// ---------------------------------------------------------------------------

function connect(path: string, protocols?: string | string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`failed to connect ${path}`));
  });
}

function nextMessage(ws: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (e) => resolve(e), { once: true });
  });
}

function nextClose(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (e) => resolve(e), { once: true });
  });
}

describe("websocket — client API", () => {
  test("echoes a text message", async () => {
    const ws = await connect("/echo");
    ws.send("hello unicode 你好 🚀");
    const msg = await nextMessage(ws);
    assert.equal(msg.data, "hello unicode 你好 🚀");
    ws.close();
  });

  test("echoes a binary message", async () => {
    const ws = await connect("/echo");
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    ws.send(payload);
    const msg = await nextMessage(ws);
    assert.deepEqual(new Uint8Array(msg.data as ArrayBuffer), payload);
    ws.close();
  });

  test("server can push then close with a code", async () => {
    const ws = await connect("/push");
    const msg = await nextMessage(ws);
    assert.equal(msg.data, "welcome");
    const close = await nextClose(ws);
    assert.equal(close.code, 1000);
  });

  test("negotiates a subprotocol the server offers", async () => {
    const ws = await connect("/chat", ["chat", "other"]);
    assert.equal(ws.protocol, "chat");
    const msg = await nextMessage(ws);
    assert.equal(msg.data, "protocol:chat");
    ws.close();
  });

  test("server-initiated close carries a custom code", async () => {
    const ws = await connect("/closer");
    ws.send("bye");
    const close = await nextClose(ws);
    assert.equal(close.code, 4001);
  });

  test("a large message round-trips (multi-read reassembly)", async () => {
    const ws = await connect("/echo");
    const big = "x".repeat(256 * 1024);
    ws.send(big);
    const msg = await nextMessage(ws);
    assert.equal((msg.data as string).length, big.length);
    assert.equal(msg.data, big);
    ws.close();
  });

  test("many concurrent connections each echo independently", async () => {
    const sockets = await Promise.all(Array.from({ length: 30 }, () => connect("/echo")));
    const replies = await Promise.all(
      sockets.map((ws, i) => {
        const got = nextMessage(ws);
        ws.send(`n${i}`);
        return got;
      }),
    );
    replies.forEach((m, i) => assert.equal(m.data, `n${i}`));
    for (const ws of sockets) ws.close();
  });

  test("a plain GET to a ws route gets 426 Upgrade Required", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/echo`, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    assert.equal(status, 426);
  });
});

// ---------------------------------------------------------------------------
// protocol conformance — a raw client that can send malformed frames
// ---------------------------------------------------------------------------

interface Frame {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

class RawWs {
  readonly #socket: net.Socket;
  #buf: Buffer = Buffer.alloc(0);
  readonly #frames: Frame[] = [];
  #waiter: ((frame: Frame) => void) | undefined;

  private constructor(socket: net.Socket, leftover: Buffer) {
    this.#socket = socket;
    socket.on("data", (chunk) => this.#feed(chunk));
    if (leftover.length > 0) this.#feed(leftover);
  }

  static connect(targetPort: number, path: string): Promise<RawWs> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(targetPort, "127.0.0.1", () => {
        const key = crypto.randomBytes(16).toString("base64");
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      socket.once("error", reject);
      let acc = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        acc = Buffer.concat([acc, chunk]);
        const end = acc.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.removeListener("data", onData);
        const head = acc.subarray(0, end).toString();
        if (!head.startsWith("HTTP/1.1 101")) {
          reject(new Error(`handshake failed: ${head.split("\r\n")[0]}`));
          return;
        }
        resolve(new RawWs(socket, acc.subarray(end + 4)));
      };
      socket.on("data", onData);
    });
  }

  #feed(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const frame = this.#parse();
      if (!frame) break;
      if (this.#waiter) {
        const w = this.#waiter;
        this.#waiter = undefined;
        w(frame);
      } else {
        this.#frames.push(frame);
      }
    }
  }

  // server frames are never masked
  #parse(): Frame | undefined {
    const b = this.#buf;
    if (b.length < 2) return undefined;
    const fin = (b[0]! & 0x80) !== 0;
    const opcode = b[0]! & 0x0f;
    let len = b[1]! & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return undefined;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return undefined;
      len = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    if (b.length < offset + len) return undefined;
    const payload = b.subarray(offset, offset + len);
    this.#buf = b.subarray(offset + len);
    return { opcode, payload: Buffer.from(payload), fin };
  }

  // frame header declaring `declaredLen` but with only a few payload bytes behind it.
  // The server rejects oversize frames on the header alone, so we never send the bulk
  // and the close frame comes back clean (no RST from unread input).
  sendOversizeHeader(opcode: number, declaredLen: number): void {
    const head = Buffer.from([
      0x80 | opcode,
      0x80 | 127,
      0,
      0,
      0,
      0,
      (declaredLen >>> 24) & 0xff,
      (declaredLen >> 16) & 0xff,
      (declaredLen >> 8) & 0xff,
      declaredLen & 0xff,
    ]);
    this.#socket.write(Buffer.concat([head, crypto.randomBytes(4), Buffer.from([1, 2, 3, 4])]));
  }

  send(
    opcode: number,
    payload: Uint8Array | string,
    opts: { mask?: boolean; rsv?: number; fin?: boolean } = {},
  ): void {
    const { mask = true, rsv = 0, fin = true } = opts;
    const body = Buffer.from(typeof payload === "string" ? Buffer.from(payload) : payload);
    const head: number[] = [(fin ? 0x80 : 0) | (rsv << 4) | opcode];
    const len = body.length;
    const maskBit = mask ? 0x80 : 0;
    if (len < 126) head.push(maskBit | len);
    else if (len < 65536) head.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
    else {
      head.push(
        maskBit | 127,
        0,
        0,
        0,
        0,
        (len >>> 24) & 0xff,
        (len >> 16) & 0xff,
        (len >> 8) & 0xff,
        len & 0xff,
      );
    }
    const parts = [Buffer.from(head)];
    if (mask) {
      const key = crypto.randomBytes(4);
      const masked = Buffer.from(body);
      for (let i = 0; i < masked.length; i++) masked[i]! ^= key[i & 3]!;
      parts.push(key, masked);
    } else {
      parts.push(body);
    }
    this.#socket.write(Buffer.concat(parts));
  }

  nextFrame(): Promise<Frame> {
    const queued = this.#frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}

const OP = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa, cont: 0x0 } as const;

function closeCode(frame: Frame): number {
  assert.equal(frame.opcode, OP.close, "expected a close frame");
  return frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0;
}

describe("websocket — protocol conformance", () => {
  test("reassembles a fragmented text message", async () => {
    const ws = await RawWs.connect(port, "/echo");
    ws.send(OP.text, "Hel", { fin: false });
    ws.send(OP.cont, "lo", { fin: true });
    const reply = await ws.nextFrame();
    assert.equal(reply.opcode, OP.text);
    assert.equal(reply.payload.toString(), "Hello");
    ws.close();
  });

  test("auto-answers a ping with a pong and fires the ping event", async () => {
    const ws = await RawWs.connect(port, "/echo");
    ws.send(OP.ping, "hi");
    const first = await ws.nextFrame();
    assert.equal(first.opcode, OP.pong);
    assert.equal(first.payload.toString(), "hi");
    const second = await ws.nextFrame(); // handler's socket.send("got-ping")
    assert.equal(second.payload.toString(), "got-ping");
    ws.close();
  });

  test("rejects an unmasked client frame with 1002", async () => {
    const ws = await RawWs.connect(port, "/echo");
    ws.send(OP.text, "nope", { mask: false });
    assert.equal(closeCode(await ws.nextFrame()), 1002);
    ws.close();
  });

  test("rejects a reserved (RSV) bit with 1002", async () => {
    const ws = await RawWs.connect(port, "/echo");
    ws.send(OP.text, "nope", { rsv: 0x4 });
    assert.equal(closeCode(await ws.nextFrame()), 1002);
    ws.close();
  });

  test("rejects invalid UTF-8 in a text frame with 1007", async () => {
    const ws = await RawWs.connect(port, "/echo");
    ws.send(OP.text, Buffer.from([0xff, 0xfe, 0xfd]));
    assert.equal(closeCode(await ws.nextFrame()), 1007);
    ws.close();
  });

  test("rejects a too-big message with 1009", async () => {
    const ws = await RawWs.connect(port, "/echo");
    ws.sendOversizeHeader(OP.text, 600 * 1024); // declares > the 512 KiB cap
    assert.equal(closeCode(await ws.nextFrame()), 1009);
    ws.close();
  });

  test("echoes the close code back on a clean close", async () => {
    const ws = await RawWs.connect(port, "/echo");
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1000, 0);
    ws.send(OP.close, payload);
    assert.equal(closeCode(await ws.nextFrame()), 1000);
    ws.close();
  });
});
