import { constants, deflateRawSync, inflateRawSync } from "node:zlib";
import { native } from "../native/native.ts";
import type { TokiRequest } from "../http/request.ts";

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);
// permessage-deflate (RFC 7692): the sync-flush marker appended before inflating,
// and the empty-message payload (a single 0x00 deflate block)
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const EMPTY_DEFLATE_BLOCK = Buffer.from([0x00]);

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Event codes shared with the native dispatcher (see websocket.zig). */
export const WS_EVENT = {
  open: 0,
  message: 1,
  close: 2,
  ping: 3,
  pong: 4,
  drain: 5,
} as const;

export type MessageListener = (data: Buffer, isBinary: boolean) => void;
export type CloseListener = (code: number, reason: string) => void;
export type BufferListener = (data: Buffer) => void;
export type DrainListener = () => void;
type Listener = MessageListener | CloseListener | BufferListener | DrainListener;

/**
 * A live WebSocket connection. Attach listeners with {@link TokiWebSocket.on} and
 * send with {@link TokiWebSocket.send}. The `Buffer` handed to the `message`,
 * `ping`, and `pong` listeners is a view over native memory valid only for the
 * duration of the call. To keep it, copy first (e.g. `Buffer.from(data)` or
 * `data.toString()`).
 */
export class TokiWebSocket {
  /** The negotiated subprotocol, or `""` when none was agreed. */
  readonly protocol: string;
  /** Free-form per-connection state for the application to use. */
  data: Record<string, unknown> = {};
  /** `true` once the connection has closed. */
  closed = false;

  readonly #id: number;
  readonly #deflate: boolean;
  readonly #maxMessage: number;
  #onMessage?: MessageListener;
  #onClose?: CloseListener;
  #onPing?: BufferListener;
  #onPong?: BufferListener;
  #onDrain?: DrainListener;

  /** @internal */
  constructor(id: number, protocol: string, deflate: boolean, maxMessage: number) {
    this.#id = id;
    this.protocol = protocol;
    this.#deflate = deflate;
    this.#maxMessage = maxMessage;
  }

  /**
   * Send a text (`string`) or binary (`Uint8Array`) message. Returns the socket's
   * write backlog in bytes — `0` once flushed, `-1` if the connection is closed.
   * When the backlog grows, pause and resume on the `drain` event.
   */
  send(data: string | Uint8Array): number {
    if (this.closed) return -1;
    const isBinary = typeof data !== "string";
    const bytes = isBinary ? data : encoder.encode(data);
    if (this.#deflate) {
      const out = deflateRawSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH });
      // drop the trailing sync-flush marker; an empty message becomes a single 0x00 block
      const body = out.length > 4 ? out.subarray(0, out.length - 4) : EMPTY_DEFLATE_BLOCK;
      return native.wsSend(this.#id, isBinary ? 1 : 0, body, 1);
    }
    return native.wsSend(this.#id, isBinary ? 1 : 0, bytes, 0);
  }

  /** Send a ping; the peer answers with a pong. Payload is capped at 125 bytes. */
  ping(data?: Uint8Array): void {
    if (!this.closed) native.wsPing(this.#id, data ?? EMPTY);
  }

  /** Send an unsolicited pong, e.g. a one-way heartbeat. Payload is capped at 125 bytes. */
  pong(data?: Uint8Array): void {
    if (!this.closed) native.wsPong(this.#id, data ?? EMPTY);
  }

  /** Send a close frame with `code` (default `1000`) and tear the connection down. */
  close(code = 1000): void {
    if (!this.closed) native.wsClose(this.#id, code);
  }

  /** Fires for each complete message. */
  on(event: "message", listener: MessageListener): this;
  /** Fires once when the connection closes, with the peer's close code and reason. */
  on(event: "close", listener: CloseListener): this;
  /** Fires on an incoming ping (a pong is sent automatically) or pong. */
  on(event: "ping" | "pong", listener: BufferListener): this;
  /** Fires when a backpressured socket's write queue empties. */
  on(event: "drain", listener: DrainListener): this;
  on(event: string, listener: Listener): this {
    switch (event) {
      case "message":
        this.#onMessage = listener as MessageListener;
        break;
      case "close":
        this.#onClose = listener as CloseListener;
        break;
      case "ping":
        this.#onPing = listener as BufferListener;
        break;
      case "pong":
        this.#onPong = listener as BufferListener;
        break;
      case "drain":
        this.#onDrain = listener as DrainListener;
        break;
    }
    return this;
  }

  /** @internal */ _message(payload: Buffer, isBinary: boolean, compressed: boolean): void {
    let data = payload;
    if (compressed) {
      try {
        // SYNC_FLUSH: the payload is sync-flushed (no final block); maxOutputLength
        // bounds the output so a compression bomb can't exhaust memory
        data = inflateRawSync(Buffer.concat([payload, DEFLATE_TAIL]), {
          finishFlush: constants.Z_SYNC_FLUSH,
          maxOutputLength: this.#maxMessage,
        });
      } catch {
        this.close(1009); // malformed or oversized compressed payload
        return;
      }
      if (!isBinary && !isValidUtf8(data)) {
        this.close(1007);
        return;
      }
    }
    this.#onMessage?.(data, isBinary);
  }
  /** @internal */ _ping(data: Buffer): void {
    this.#onPing?.(data);
  }
  /** @internal */ _pong(data: Buffer): void {
    this.#onPong?.(data);
  }
  /** @internal */ _drain(): void {
    this.#onDrain?.();
  }
  /** @internal */ _close(code: number, reason: string): void {
    this.closed = true;
    this.#onClose?.(code, reason);
  }
}

/** Per-route WebSocket configuration passed to `app.ws`. */
export interface WebSocketOptions {
  /** Subprotocols this route supports; the server echoes the first the client also offers. */
  protocols?: string[];
}

/** Runs once per accepted connection. Attach listeners to `socket` here. */
export type WebSocketHandler = (socket: TokiWebSocket, req: TokiRequest) => void;
