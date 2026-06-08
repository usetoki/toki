import { native, type RemoteInfo, type TcpOptions } from "../native/native.js";

export type { RemoteInfo, TcpOptions } from "../native/native.js";

/** A single accepted TCP connection. Reads arrive as `data`; backpressure is reported
 *  by {@link TcpSocket.write} returning `false` until the next `drain`. */
export interface TcpSocket {
  readonly remoteAddress: string;
  readonly remotePort: number;
  /** Send bytes. Returns `false` when the send buffer is backed up — stop writing and
   *  resume on `drain`. A string is encoded as UTF-8. */
  write(data: Uint8Array | string): boolean;
  /** Flush queued writes, optionally send a final chunk, then half-close (FIN). */
  end(data?: Uint8Array | string): void;
  /** Drop the connection now, without waiting for queued writes. */
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "drain" | "close", listener: () => void): this;
  off(event: "data" | "drain" | "close", listener: (...args: never[]) => void): this;
}

/** The listening TCP server returned by {@link createTcpServer}. */
export interface TcpServer {
  /** Bind and start accepting. `0` picks a free port; the chosen port is returned. */
  listen(port: number, host?: string): { port: number };
  /** Stop accepting and close every live connection. */
  close(): void;
}

const enum Ev {
  Connection = 0,
  Data = 1,
  Drain = 2,
  Close = 3,
}

// One raw TCP server per process — the native engine is a singleton, so a second
// listener would clobber the first. Mirrors the HTTP `app.listen` rule.
let active = false;

class Socket implements TcpSocket {
  readonly remoteAddress: string;
  readonly remotePort: number;
  #id: number;
  #ended = false;
  #data: Array<(chunk: Buffer) => void> = [];
  #drain: Array<() => void> = [];
  #close: Array<() => void> = [];

  constructor(id: number, remote: RemoteInfo) {
    this.#id = id;
    this.remoteAddress = remote.address;
    this.remotePort = remote.port;
  }

  write(data: Uint8Array | string): boolean {
    if (this.#ended) return false;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    // native returns the unflushed backlog; non-zero means the socket buffer is full.
    return native.tcpSend(this.#id, bytes) === 0;
  }

  end(data?: Uint8Array | string): void {
    if (this.#ended) return;
    if (data !== undefined) this.write(data);
    this.#ended = true;
    native.tcpEnd(this.#id);
  }

  destroy(): void {
    if (this.#ended) return;
    this.#ended = true;
    native.tcpClose(this.#id);
  }

  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "drain" | "close", listener: () => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    this.#bucket(event).push(listener as never);
    return this;
  }

  off(event: "data" | "drain" | "close", listener: (...args: never[]) => void): this {
    const bucket = this.#bucket(event);
    const i = bucket.indexOf(listener as never);
    if (i !== -1) bucket.splice(i, 1);
    return this;
  }

  #bucket(event: string): Array<(...args: never[]) => void> {
    if (event === "data") return this.#data as Array<(...args: never[]) => void>;
    if (event === "drain") return this.#drain as Array<(...args: never[]) => void>;
    if (event === "close") return this.#close as Array<(...args: never[]) => void>;
    return [];
  }

  /** @internal */ emitData(chunk: Buffer): void {
    for (const fn of this.#data) fn(chunk);
  }
  /** @internal */ emitDrain(): void {
    for (const fn of this.#drain) fn();
  }
  /** @internal */ emitClose(): void {
    for (const fn of this.#close) fn();
  }
}

/** Start a raw TCP server. `handler` runs once per accepted connection. One server per
 *  process (scale across cores with `reusePort` and multiple processes). */
export function createTcpServer(
  handler: (socket: TcpSocket) => void,
  options: TcpOptions = {},
): TcpServer {
  const sockets = new Map<number, Socket>();

  const dispatch = (id: number, event: Ev, arg: RemoteInfo | Uint8Array | undefined): void => {
    switch (event) {
      case Ev.Connection: {
        const socket = new Socket(id, arg as RemoteInfo);
        sockets.set(id, socket);
        handler(socket);
        return;
      }
      case Ev.Data:
        // native already hands us a private, V8-owned copy — safe to retain
        sockets.get(id)?.emitData(arg as Buffer);
        return;
      case Ev.Drain:
        sockets.get(id)?.emitDrain();
        return;
      case Ev.Close: {
        const socket = sockets.get(id);
        if (socket === undefined) return;
        sockets.delete(id);
        socket.emitClose();
        return;
      }
    }
  };

  return {
    listen(port: number, host = "0.0.0.0"): { port: number } {
      if (active) throw new Error("toki: a TCP server is already listening in this process");
      const bound = native.tcpListen(port, host, options, dispatch as never);
      active = true;
      return { port: bound };
    },
    close(): void {
      if (!active) return;
      native.tcpCloseServer();
      active = false;
      sockets.clear();
    },
  };
}
