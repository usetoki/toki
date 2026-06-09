import { native, type RemoteInfo, type TcpOptions } from "../native/native.ts";

export type { RemoteInfo, TcpOptions } from "../native/native.ts";

/** A single accepted TCP connection. Reads arrive as `data`; backpressure is reported
 *  by {@link TcpSocket.write} returning `false` until the next `drain`. */
export interface TcpSocket {
  readonly remoteAddress: string;
  readonly remotePort: number;
  /** TLS only: `true` when the peer presented a client certificate that verified against the
   *  server's `tls.ca`. `false` on a plaintext connection, or a TLS connection where no valid
   *  client cert was presented (only reachable without `rejectUnauthorized`). */
  readonly authorized: boolean;
  /** Send bytes. Returns `false` when the send buffer is backed up: stop writing and
   *  resume on `drain`. A string is encoded as UTF-8. */
  write(data: Uint8Array | string): boolean;
  /** Flush queued writes, optionally send a final chunk, then half-close (FIN). */
  end(data?: Uint8Array | string): void;
  /** Drop the connection now, without waiting for queued writes. */
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "drain" | "end" | "close", listener: () => void): this;
  off(event: "data" | "drain" | "end" | "close", listener: (...args: never[]) => void): this;
}

/** Options for {@link createTcpServer}. */
export interface TcpServerOptions extends TcpOptions {
  /** Keep the write side open after the peer half-closes (FIN). Default `false`: the write
   *  side is ended automatically once its backlog has flushed, like Node's `net`. */
  allowHalfOpen?: boolean;
  /**
   * Native per-IP accept limit, enforced in the engine before the TLS handshake runs and
   * before the connection ever reaches JS. An over-limit peer is reset at accept — it costs
   * the server no key exchange and no dispatch. Counts accepts (not bytes or requests);
   * for per-key application budgets see `@usetoki/toki-ratelimiter`'s `tcpRateLimit`.
   */
  rateLimit?: { max: number; windowMs: number };
  /**
   * Terminate TLS on the raw socket (no reverse proxy). PEM cert chain (leaf first) +
   * private key — RSA or EC. TLS 1.3 only (AEAD suites). The handler runs once the
   * handshake completes, so the first `write` is already over an established session.
   *
   * Mutual TLS (client certificate authentication): set `requestCert` and a `ca` bundle to
   * ask the client for a certificate and verify it against `ca`. With `rejectUnauthorized`
   * a missing or untrusted client cert fails the handshake (the connection never reaches the
   * handler); without it the connection is allowed and {@link TcpSocket.authorized} reports
   * whether a valid cert was presented.
   */
  tls?: {
    cert: string | Uint8Array;
    key: string | Uint8Array;
    /** request a client certificate during the handshake (enables mTLS) */
    requestCert?: boolean;
    /** with `requestCert`, reject a client whose cert is missing or untrusted */
    rejectUnauthorized?: boolean;
    /** PEM CA bundle the client certificate is verified against */
    ca?: string | Uint8Array;
  };
}

/** The listening TCP server returned by {@link createTcpServer}. */
export interface TcpServer {
  /** Bind and start accepting. `0` picks a free port; the chosen port is returned. */
  listen(port: number, host?: string): { port: number };
  /** Stop accepting and close every live connection. */
  close(): void;
}

// event tags from the native dispatcher, matched in src/net/tcp.zig
const Ev = { Connection: 0, Data: 1, Drain: 2, Close: 3, End: 4 } as const;
type Ev = (typeof Ev)[keyof typeof Ev];

// One raw TCP server per process. The native engine is a singleton, so a second
// listener would clobber the first. Mirrors the HTTP `app.listen` rule.
let active = false;

// TLS cert/key accepted as PEM text or raw bytes; native reads a Buffer.
function toPem(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

const EMPTY_PEER: RemoteInfo = { address: "", port: 0 };

class Socket implements TcpSocket {
  readonly #id: number;
  readonly #allowHalfOpen: boolean;
  #peer?: RemoteInfo; // peer address, fetched from native on first access then cached
  #ended = false; // we've ended our write side
  #readEnded = false; // peer half-closed
  #needDrain = false; // a write is backed up; a drain is pending
  #data: Array<(chunk: Buffer) => void> = [];
  #drain: Array<() => void> = [];
  #end: Array<() => void> = [];
  #close: Array<() => void> = [];

  constructor(id: number, allowHalfOpen: boolean) {
    this.#id = id;
    this.#allowHalfOpen = allowHalfOpen;
  }

  // Peer fields are read lazily: a handler that never inspects the address costs no
  // getpeername and no native object build. An empty result (the connection closed before
  // anyone asked) is cached too, so native is hit at most once.
  #fetchPeer(): RemoteInfo {
    return (this.#peer ??= native.tcpPeer(this.#id) ?? EMPTY_PEER);
  }
  get remoteAddress(): string {
    return this.#fetchPeer().address;
  }
  get remotePort(): number {
    return this.#fetchPeer().port;
  }
  /** TLS connections only: whether the peer presented a client cert that verified against
   *  `tls.ca`. `false` on plaintext or an unverified client. */
  get authorized(): boolean {
    return this.#fetchPeer().authorized ?? false;
  }

  write(data: Uint8Array | string): boolean {
    if (this.#ended) return false;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    // native returns the unflushed backlog; non-zero means the socket buffer is full.
    const flushed = native.tcpSend(this.#id, bytes) === 0;
    if (!flushed) this.#needDrain = true;
    return flushed;
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
  on(event: "drain" | "end" | "close", listener: () => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    this.#bucket(event).push(listener as never);
    return this;
  }

  off(event: "data" | "drain" | "end" | "close", listener: (...args: never[]) => void): this {
    const bucket = this.#bucket(event);
    const i = bucket.indexOf(listener as never);
    if (i !== -1) bucket.splice(i, 1);
    return this;
  }

  #bucket(event: string): Array<(...args: never[]) => void> {
    if (event === "data") return this.#data as Array<(...args: never[]) => void>;
    if (event === "drain") return this.#drain as Array<(...args: never[]) => void>;
    if (event === "end") return this.#end as Array<(...args: never[]) => void>;
    if (event === "close") return this.#close as Array<(...args: never[]) => void>;
    return [];
  }

  // close our write side once the peer has gone and our backlog has flushed — unless the
  // app opted into half-open or already ended it.
  #maybeAutoEnd(): void {
    if (this.#readEnded && !this.#allowHalfOpen && !this.#needDrain && !this.#ended) this.end();
  }

  /** @internal */ emitData(chunk: Buffer): void {
    for (const fn of this.#data) fn(chunk);
  }
  /** @internal */ emitDrain(): void {
    this.#needDrain = false;
    for (const fn of this.#drain) fn();
    // the app's drain handler may have written more (re-arming #needDrain); only end if not.
    this.#maybeAutoEnd();
  }
  /** @internal */ emitEnd(): void {
    this.#readEnded = true;
    for (const fn of this.#end) fn();
    this.#maybeAutoEnd();
  }
  /** @internal */ emitClose(): void {
    for (const fn of this.#close) fn();
  }
}

/** Start a raw TCP server. `handler` runs once per accepted connection. One server per
 *  process (scale across cores with `reusePort` and multiple processes). */
export function createTcpServer(
  handler: (socket: TcpSocket) => void,
  options: TcpServerOptions = {},
): TcpServer {
  const allowHalfOpen = options.allowHalfOpen ?? false;
  const sockets = new Map<number, Socket>();

  // flatten the tls option into the cert/key buffers native reads (mirrors app.listen).
  // mTLS: a `ca` bundle + `requestCert` turns on client-cert auth; `rejectUnauthorized`
  // makes it mandatory (.require) rather than just requested (.request).
  let nativeOptions: TcpServerOptions = options;
  if (options.rateLimit) {
    nativeOptions = {
      ...options,
      rateLimitMax: options.rateLimit.max,
      rateLimitWindowMs: options.rateLimit.windowMs,
    };
  }
  if (options.tls) {
    nativeOptions = {
      ...nativeOptions,
      tlsCert: toPem(options.tls.cert),
      tlsKey: toPem(options.tls.key),
    };
    if (options.tls.requestCert) {
      if (options.tls.ca === undefined) {
        throw new Error(
          "toki: tls.requestCert needs tls.ca (the CA bundle that signs client certs)",
        );
      }
      nativeOptions.tlsClientCa = toPem(options.tls.ca);
      nativeOptions.tlsRequireClient = options.tls.rejectUnauthorized === true;
    }
  }

  const dispatch = (id: number, event: Ev, arg: Uint8Array | undefined): void => {
    switch (event) {
      case Ev.Connection: {
        const socket = new Socket(id, allowHalfOpen);
        sockets.set(id, socket);
        handler(socket);
        return;
      }
      case Ev.Data:
        // native already hands us a private, V8-owned copy; safe to retain
        sockets.get(id)?.emitData(arg as Buffer);
        return;
      case Ev.Drain:
        sockets.get(id)?.emitDrain();
        return;
      case Ev.End:
        sockets.get(id)?.emitEnd();
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
      const bound = native.tcpListen(port, host, nativeOptions, dispatch as never);
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
