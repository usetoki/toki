import { native, type RemoteInfo, type TcpOptions } from "../native/native.ts";

export type { RemoteInfo, TcpOptions } from "../native/native.ts";

/** Why a connection closed, reported on the `close` event and via {@link TcpSocket.closeReason}.
 *  `normal` covers a clean local/peer close; the rest are abnormal. */
export type CloseReason =
  | "normal"
  | "peer-reset"
  | "write-queue-overflow"
  | "tls-error"
  | "handshake-timeout";

/** A single accepted TCP connection. Reads arrive as `data`; backpressure is reported
 *  by {@link TcpSocket.write} returning `false` until the next `drain`. */
export interface TcpSocket {
  readonly remoteAddress: string;
  readonly remotePort: number;
  /** TLS only: `true` when the peer presented a client certificate that verified against the
   *  server's `tls.ca`. `false` on a plaintext connection, or a TLS connection where no valid
   *  client cert was presented (only reachable without `rejectUnauthorized`). */
  readonly authorized: boolean;
  /** Why the connection closed; `"normal"` until an abnormal close sets it. Read it inside a
   *  `close` listener (also passed as the listener's argument). */
  readonly closeReason: CloseReason;
  /** TLS only: the ALPN protocol negotiated for this connection, or `undefined` on a plaintext
   *  connection or when none was negotiated. */
  readonly alpnProtocol: string | undefined;
  /** Send bytes. Returns `false` when the send buffer is backed up (resume on `drain`) or the
   *  socket is gone (closed or closing). A string is encoded as UTF-8. */
  write(data: Uint8Array | string): boolean;
  /** Flush queued writes, optionally send a final chunk, then half-close (FIN). On a TLS
   *  connection a `close_notify` is sent first, so the peer gets a clean close, never a reset. */
  end(data?: Uint8Array | string): void;
  /** Drop the connection now, without waiting for queued writes (RST). */
  destroy(): void;
  /** TLS only: derive `length` bytes of keying material bound to this session (RFC 8446 §7.5;
   *  RFC 9266 `tls-exporter` channel binding) from `label` and an optional `context`. Both peers
   *  derive identical bytes. `undefined` on a plaintext connection. */
  exportKeyingMaterial(length: number, label: string, context?: Uint8Array): Buffer | undefined;
  /** TLS only: the peer's leaf certificate in DER — the server's certificate on a `connectTcp`
   *  client, the client's on a server (mutual TLS). `undefined` on a plaintext connection, or when
   *  no peer certificate was retained (none was sent, or it exceeded the retained-cert size). */
  peerCertificate(): Buffer | undefined;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "close", listener: (reason: CloseReason) => void): this;
  on(event: "drain" | "end", listener: () => void): this;
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
   * I/O backend. `"libuv"` (default) runs on Node's libuv loop and works on every platform.
   * `"io_uring"` runs the accept/recv/send path through a Linux io_uring ring driven on the
   * same loop (no thread hop) with a shared provided-buffer pool — lower syscall overhead and
   * flat memory under many connections. Linux only, plaintext only (TLS stays on `"libuv"`),
   * and the kernel's io_uring syscalls must be permitted (containers often need a seccomp
   * profile that allows them). On a non-Linux host it throws; fall back to `"libuv"`.
   */
  engine?: "libuv" | "io_uring";
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
    /** ALPN protocols to offer, in preference order (e.g. `["h2", "http/1.1"]`). The negotiated
     *  one is on {@link TcpSocket.alpnProtocol}. */
    alpn?: string[];
  };
}

/** The listening TCP server returned by {@link createTcpServer}. */
export interface TcpServer {
  /** Bind and start accepting. `0` picks a free port; the chosen port is returned. */
  listen(port: number, host?: string): { port: number };
  /** Stop accepting and close every live connection. */
  close(): void;
}

/** Why an outbound {@link connectTcp} failed, carried on {@link TcpConnectError.reason}. */
export type ConnectErrorReason =
  | "dns" // the host did not resolve
  | "refused" // the TCP connection was refused, unreachable, or reset before it came up
  | "timeout" // the connect (or TLS handshake) outran `timeoutMs`
  | "tls-verify"; // the server certificate failed verification (chain or host name)

/** Rejection from {@link connectTcp}: a typed {@link ConnectErrorReason} plus the target. */
export class TcpConnectError extends Error {
  readonly reason: ConnectErrorReason;
  readonly host: string;
  readonly port: number;
  constructor(reason: ConnectErrorReason, host: string, port: number) {
    super(`toki: connect to ${host}:${port} failed (${reason})`);
    this.name = "TcpConnectError";
    this.reason = reason;
    this.host = host;
    this.port = port;
  }
}

/** Options for {@link connectTcp}. */
export interface TcpConnectOptions {
  /** Nagle's algorithm; default off (low latency), like the server. */
  noDelay?: boolean;
  /** Fail the connect (and TLS handshake) if it hasn't completed within this many ms. */
  timeoutMs?: number;
  /** Keep the read side open after we half-close. Default `false` (Node `net` behaviour). */
  allowHalfOpen?: boolean;
  /**
   * Terminate TLS as the client. `true` uses the system trust store and verifies the server
   * certificate against `host`. An object customises it: `servername` overrides the SNI/verify
   * name, `ca` supplies a PEM bundle to trust instead of the system roots, `cert`/`key` present
   * a client certificate for mutual TLS, and `rejectUnauthorized: false` skips verification
   * entirely (test/self-signed only).
   */
  tls?:
    | boolean
    | {
        /** SNI sent and the name the server certificate is verified against; defaults to `host` */
        servername?: string;
        /** PEM CA bundle to trust instead of the system roots */
        ca?: string | Uint8Array;
        /** PEM client-certificate chain to present for mutual TLS (with `key`) */
        cert?: string | Uint8Array;
        /** PEM private key for the client `cert` */
        key?: string | Uint8Array;
        /** verify the server certificate; default `true`. `false` accepts any cert (unsafe) */
        rejectUnauthorized?: boolean;
        /** ALPN protocols to offer, in preference order; the negotiated one is on
         *  {@link TcpSocket.alpnProtocol}. */
        alpn?: string[];
      };
}

// event tags from the native dispatcher, matched in src/net/tcp.zig
const Ev = { Connection: 0, Data: 1, Drain: 2, Close: 3, End: 4 } as const;
type Ev = (typeof Ev)[keyof typeof Ev];

// close-reason codes from the native dispatcher (ev_close arg), indexed by the code.
const CLOSE_REASONS: readonly CloseReason[] = [
  "normal",
  "peer-reset",
  "write-queue-overflow",
  "tls-error",
  "handshake-timeout",
];

// tcpSend returns this when the connection is gone — distinguishes a real "flushed" (0) from a
// write that landed after close. Matched to send_gone in src/net/tcp.zig.
const SEND_GONE = 0xffffffff;

// One raw TCP server per process. The native engine is a singleton, so a second
// listener would clobber the first. Mirrors the HTTP `app.listen` rule.
let active = false;

// TLS cert/key accepted as PEM text or raw bytes; native reads a Buffer.
function toPem(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

// ALPN protocol list -> wire format native parses: each protocol is a 1-byte length + its bytes.
function encodeAlpn(protocols: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const p of protocols) {
    const b = Buffer.from(p, "utf8");
    if (b.length === 0 || b.length > 255) {
      throw new Error(`toki: ALPN protocol "${p}" must be 1..255 bytes`);
    }
    parts.push(Buffer.from([b.length]), b);
  }
  return Buffer.concat(parts);
}

const EMPTY_PEER: RemoteInfo = { address: "", port: 0 };

// the native functions for one engine. The libuv and io_uring backends expose the same
// six calls, so the Socket and server just hold whichever set the `engine` option picked.
interface TcpBackend {
  listen: typeof native.tcpListen;
  send: typeof native.tcpSend;
  peer: typeof native.tcpPeer;
  end: typeof native.tcpEnd;
  close: typeof native.tcpClose;
  closeServer: typeof native.tcpCloseServer;
}

const LIBUV_BACKEND: TcpBackend = {
  listen: native.tcpListen,
  send: native.tcpSend,
  peer: native.tcpPeer,
  end: native.tcpEnd,
  close: native.tcpClose,
  closeServer: native.tcpCloseServer,
};

const URING_BACKEND: TcpBackend = {
  listen: native.tcpUringListen,
  send: native.tcpUringSend,
  peer: native.tcpUringPeer,
  end: native.tcpUringEnd,
  close: native.tcpUringClose,
  closeServer: native.tcpUringCloseServer,
};

// io_uring is opt-in and conditional: it's Linux-only and (for now) plaintext-only. When a
// caller asks for it where it can't run, fall back to libuv and say why once, rather than
// failing the server — the app keeps working, just on the portable engine.
function selectBackend(options: TcpServerOptions): TcpBackend {
  if (options.engine !== "io_uring") return LIBUV_BACKEND;
  if (process.platform !== "linux") {
    console.warn(
      `toki: the io_uring engine is Linux-only — falling back to the default libuv engine on ${process.platform}.`,
    );
    return LIBUV_BACKEND;
  }
  if (options.tls) {
    console.warn(
      "toki: the io_uring engine does not terminate TLS yet — falling back to the default libuv engine for this TLS server.",
    );
    return LIBUV_BACKEND;
  }
  if (!native.tcpUringAvailable()) {
    console.warn(
      "toki: io_uring is unavailable here (kernel too old, or the syscalls are blocked by the container sandbox) — falling back to the default libuv engine.",
    );
    return LIBUV_BACKEND;
  }
  return URING_BACKEND;
}

class Socket implements TcpSocket {
  readonly #id: number;
  readonly #allowHalfOpen: boolean;
  readonly #backend: TcpBackend;
  #peer?: RemoteInfo; // peer address, fetched from native on first access then cached
  #ended = false; // we've ended our write side
  #readEnded = false; // peer half-closed
  #needDrain = false; // a write is backed up; a drain is pending
  #closeReason: CloseReason = "normal";
  #alpnFetched = false;
  #alpnProtocol: string | undefined = undefined;
  #data: Array<(chunk: Buffer) => void> = [];
  #drain: Array<() => void> = [];
  #end: Array<() => void> = [];
  #close: Array<() => void> = [];

  constructor(id: number, allowHalfOpen: boolean, backend: TcpBackend) {
    this.#id = id;
    this.#allowHalfOpen = allowHalfOpen;
    this.#backend = backend;
  }

  // Peer fields are read lazily: a handler that never inspects the address costs no
  // getpeername and no native object build. An empty result (the connection closed before
  // anyone asked) is cached too, so native is hit at most once.
  #fetchPeer(): RemoteInfo {
    return (this.#peer ??= this.#backend.peer(this.#id) ?? EMPTY_PEER);
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
  get closeReason(): CloseReason {
    return this.#closeReason;
  }
  // negotiated ALPN, fetched once from native (it doesn't change after the handshake).
  get alpnProtocol(): string | undefined {
    if (!this.#alpnFetched) {
      this.#alpnProtocol = native.tcpAlpnProtocol(this.#id);
      this.#alpnFetched = true;
    }
    return this.#alpnProtocol;
  }

  write(data: Uint8Array | string): boolean {
    if (this.#ended) return false;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    // native returns the unflushed backlog; non-zero means the socket buffer is full, and
    // SEND_GONE means the connection has gone (closed/closing) — either way, not flushed.
    const backlog = this.#backend.send(this.#id, bytes);
    if (backlog === SEND_GONE) {
      this.#ended = true;
      return false;
    }
    const flushed = backlog === 0;
    if (!flushed) this.#needDrain = true;
    return flushed;
  }

  end(data?: Uint8Array | string): void {
    if (this.#ended) return;
    if (data !== undefined) this.write(data);
    this.#ended = true;
    this.#backend.end(this.#id);
  }

  destroy(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#backend.close(this.#id);
  }

  // TLS sockets always run on the libuv engine, so the exporter is read straight from native
  // (a plaintext / io_uring id isn't in that connection table and simply yields undefined).
  exportKeyingMaterial(length: number, label: string, context?: Uint8Array): Buffer | undefined {
    return native.tcpExportKeyingMaterial(this.#id, length, label, context);
  }

  peerCertificate(): Buffer | undefined {
    return native.tcpPeerCertificate(this.#id);
  }

  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "close", listener: (reason: CloseReason) => void): this;
  on(event: "drain" | "end", listener: () => void): this;
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
  /** @internal */ emitClose(reason: CloseReason): void {
    this.#closeReason = reason;
    for (const fn of this.#close as Array<(r: CloseReason) => void>) fn(reason);
  }
}

// The native engine is a process singleton with one dispatch slot, so the server (libuv or
// io_uring) and every outbound client share this one dispatcher and connection map. Events are
// routed by id; a still-pending connect (in `pendingConnects`) is told apart from a live socket.
const sockets = new Map<number, Socket>();
type PendingConnect = {
  allowHalfOpen: boolean;
  resolve: (socket: TcpSocket) => void;
  reject: (err: TcpConnectError) => void;
  host: string;
  port: number;
};
const pendingConnects = new Map<number, PendingConnect>();
let serverHandler: ((socket: TcpSocket) => void) | undefined;
let serverHalfOpen = false;
let serverBackend: TcpBackend = LIBUV_BACKEND;
let serverIsUring = false;

// ev_close reason codes (src/net/tcp.zig) for a connect that never reached ev_connection,
// mapped to a typed connect error. tls-error (3) during the client handshake reads as a
// verification failure; a peer reset (1) before establish reads as a refusal.
const CONNECT_ERRORS: Record<number, ConnectErrorReason> = {
  1: "refused",
  3: "tls-verify",
  5: "dns",
  6: "refused",
  7: "timeout",
};

const dispatch = (id: number, event: Ev, arg: Uint8Array | undefined): void => {
  switch (event) {
    case Ev.Connection: {
      const pending = pendingConnects.get(id);
      if (pending !== undefined) {
        pendingConnects.delete(id);
        const socket = new Socket(id, pending.allowHalfOpen, LIBUV_BACKEND);
        sockets.set(id, socket);
        pending.resolve(socket);
        return;
      }
      if (serverHandler === undefined) return;
      const socket = new Socket(id, serverHalfOpen, serverBackend);
      sockets.set(id, socket);
      serverHandler(socket);
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
      const code = (arg as unknown as number) ?? 0;
      // a connect that closed before establishing rejects its promise with a typed error.
      const pending = pendingConnects.get(id);
      if (pending !== undefined) {
        pendingConnects.delete(id);
        pending.reject(
          new TcpConnectError(CONNECT_ERRORS[code] ?? "refused", pending.host, pending.port),
        );
        return;
      }
      const socket = sockets.get(id);
      if (socket === undefined) return;
      sockets.delete(id);
      socket.emitClose(CLOSE_REASONS[code] ?? "normal");
      return;
    }
  }
};

/** Start a raw TCP server. `handler` runs once per accepted connection. One server per
 *  process (scale across cores with `reusePort` and multiple processes). */
export function createTcpServer(
  handler: (socket: TcpSocket) => void,
  options: TcpServerOptions = {},
): TcpServer {
  const allowHalfOpen = options.allowHalfOpen ?? false;
  const backend = selectBackend(options);

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
    if (options.tls.alpn !== undefined) nativeOptions.tlsAlpn = encodeAlpn(options.tls.alpn);
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

  return {
    listen(port: number, host = "0.0.0.0"): { port: number } {
      if (active) throw new Error("toki: a TCP server is already listening in this process");
      const bound = backend.listen(port, host, nativeOptions, dispatch as never);
      active = true;
      serverHandler = handler;
      serverHalfOpen = allowHalfOpen;
      serverBackend = backend;
      serverIsUring = backend === URING_BACKEND;
      return { port: bound };
    },
    close(): void {
      if (!active) return;
      backend.closeServer();
      active = false;
      serverHandler = undefined;
      serverIsUring = false;
    },
  };
}

// native flattens the connect tls option the same way the server flattens its own.
function flattenConnect(options: TcpConnectOptions): TcpOptions {
  const o: TcpOptions = {};
  if (options.noDelay !== undefined) o.noDelay = options.noDelay;
  if (options.timeoutMs !== undefined) o.timeoutMs = options.timeoutMs;
  if (options.tls) {
    o.tlsClient = true;
    const t = options.tls === true ? {} : options.tls;
    if (t.servername !== undefined) o.tlsServerName = t.servername;
    if (t.ca !== undefined) o.tlsCa = toPem(t.ca);
    if (t.cert !== undefined) o.tlsCert = toPem(t.cert);
    if (t.key !== undefined) o.tlsKey = toPem(t.key);
    if (t.rejectUnauthorized === false) o.tlsInsecure = true;
    if (t.alpn !== undefined) o.tlsAlpn = encodeAlpn(t.alpn);
  }
  return o;
}

/** Open an outbound TCP (or TLS) connection. Resolves with a {@link TcpSocket} once connected —
 *  and, for TLS, once the handshake completes and the server certificate has verified. Rejects
 *  with a {@link TcpConnectError} carrying a typed {@link ConnectErrorReason} on failure. */
export function connectTcp(
  host: string,
  port: number,
  options: TcpConnectOptions = {},
): Promise<TcpSocket> {
  if (serverIsUring) {
    throw new Error(
      "toki: connectTcp shares the libuv engine and can't run alongside an io_uring server in the same process",
    );
  }
  const allowHalfOpen = options.allowHalfOpen ?? false;
  const nativeOptions = flattenConnect(options);
  return new Promise<TcpSocket>((resolve, reject) => {
    const id = native.tcpConnect(host, port, nativeOptions, dispatch as never);
    if (id === 0) {
      reject(new TcpConnectError("refused", host, port));
      return;
    }
    pendingConnects.set(id, { allowHalfOpen, resolve, reject, host, port });
  });
}
