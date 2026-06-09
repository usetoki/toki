import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { constants, deflateRawSync, inflateRawSync } from "node:zlib";
import { createApp } from "../ts/index.ts";
import { freePort } from "./helpers.ts";

// permessage-deflate needs its own app, and the native engine is a singleton, so
// it lives in a separate file (= separate process) from the main websocket tests.
const app = createApp();
app.ws("/echo", (socket) => {
  socket.on("message", (data, isBinary) => {
    socket.send(isBinary ? new Uint8Array(data) : data.toString());
  });
});

let port = 0;
let handle: { close: () => void };

before(async () => {
  port = await freePort();
  handle = app.listen(port, { host: "127.0.0.1", wsCompression: true });
});
after(() => handle.close());

const SYNC_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

function deflate(text: string): Buffer {
  const out = deflateRawSync(Buffer.from(text), { finishFlush: constants.Z_SYNC_FLUSH });
  return out.subarray(0, out.length - 4); // strip the sync-flush marker
}
function inflate(payload: Buffer): Buffer {
  return inflateRawSync(Buffer.concat([payload, SYNC_TAIL]), {
    finishFlush: constants.Z_SYNC_FLUSH,
  });
}

interface Frame {
  opcode: number;
  payload: Buffer;
  rsv1: boolean;
}

class RawWs {
  readonly #socket: net.Socket;
  #buf: Buffer = Buffer.alloc(0);
  readonly #frames: Frame[] = [];
  #waiter: ((frame: Frame) => void) | undefined;
  readonly responseHead: string;

  private constructor(socket: net.Socket, leftover: Buffer, responseHead: string) {
    this.#socket = socket;
    this.responseHead = responseHead;
    socket.on("data", (chunk) => this.#feed(chunk));
    if (leftover.length > 0) this.#feed(leftover);
  }

  static connect(targetPort: number, path: string): Promise<RawWs> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(targetPort, "127.0.0.1", () => {
        const key = crypto.randomBytes(16).toString("base64");
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
            `Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n`,
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
        resolve(new RawWs(socket, acc.subarray(end + 4), head));
      };
      socket.on("data", onData);
    });
  }

  #feed(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const frame = this.#parse();
      if (!frame) break;
      const waiter = this.#waiter;
      if (waiter) {
        this.#waiter = undefined;
        waiter(frame);
      } else {
        this.#frames.push(frame);
      }
    }
  }

  #parse(): Frame | undefined {
    const b = this.#buf;
    if (b.length < 2) return undefined;
    const rsv1 = (b[0]! & 0x40) !== 0;
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
    const payload = Buffer.from(b.subarray(offset, offset + len));
    this.#buf = b.subarray(offset + len);
    return { opcode, payload, rsv1 };
  }

  send(opcode: number, body: Buffer, rsv1: boolean): void {
    const head = [0x80 | (rsv1 ? 0x40 : 0) | opcode];
    const len = body.length;
    if (len < 126) head.push(0x80 | len);
    else head.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff);
    const key = crypto.randomBytes(4);
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i]! ^= key[i & 3]!;
    this.#socket.write(Buffer.concat([Buffer.from(head), key, masked]));
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

const OP = { text: 0x1 } as const;

describe("websocket — permessage-deflate", () => {
  test("echoes permessage-deflate in the handshake when offered", async () => {
    const ws = await RawWs.connect(port, "/echo");
    assert.match(ws.responseHead, /Sec-WebSocket-Extensions: permessage-deflate/i);
    ws.close();
  });

  test("inflates a compressed message and replies compressed", async () => {
    const ws = await RawWs.connect(port, "/echo");
    ws.send(OP.text, deflate("hello permessage-deflate"), true);
    const reply = await ws.nextFrame();
    assert.equal(reply.opcode, OP.text);
    assert.ok(reply.rsv1, "server reply should be compressed (RSV1 set)");
    assert.equal(inflate(reply.payload).toString(), "hello permessage-deflate");
    ws.close();
  });

  test("a highly compressible payload comes back smaller on the wire", async () => {
    const ws = await RawWs.connect(port, "/echo");
    const original = "a".repeat(20_000);
    ws.send(OP.text, deflate(original), true);
    const reply = await ws.nextFrame();
    assert.ok(reply.rsv1);
    assert.ok(
      reply.payload.length < 1000,
      `compressed reply should be tiny, was ${reply.payload.length}`,
    );
    assert.equal(inflate(reply.payload).toString(), original);
    ws.close();
  });

  test("interoperates with the built-in WebSocket client over deflate", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/echo`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("connect failed"));
    });
    const got = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), { once: true });
    });
    const payload = "interop ".repeat(500);
    ws.send(payload);
    assert.equal(await got, payload);
    ws.close();
  });
});
