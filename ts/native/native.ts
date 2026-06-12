// sole entry point to the Zig addon
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// dist/native/native.js → up two to the package root (where zig-out + node_modules live)
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** request handed to the dispatcher; strings decoded lazily by JS */
export interface NativeRequest {
  readonly method: string;
  readonly path: string;
  /** raw query after `?`, empty when absent */
  readonly query: string;
  /** `Name: Value\r\n` lines */
  readonly rawHeaders: string;
  /** index into handler array; `0xFFFFFFFF` is the not-found handler */
  readonly routeIndex: number;
  /** token for {@link Native.submitResponse} */
  readonly dispatchId: number;
  readonly ip: string;
  /** captured `:param`/`*` values, `null` for routes with none */
  readonly params: Record<string, string> | null;
  /** external view over the engine's buffer; valid only during dispatch */
  readonly body: Uint8Array | null;
}

/** dispatcher return; `headers` is a pre-joined block, engine owns status line + Content-Length + Connection */
export interface NativeResponse {
  status?: number;
  headers?: string;
  body?: string | Uint8Array;
}

/** static file for the engine; native derives MIME/ETag/headers, TS supplies bytes + mtime + cache policy */
export interface StaticEntry {
  readonly path: string;
  readonly body: Uint8Array;
  /** also feeds the ETag */
  readonly mtimeMs: number;
  readonly cacheControl: string;
  /** served when `Accept-Encoding` permits */
  readonly gzip?: Uint8Array;
  readonly brotli?: Uint8Array;
}

/** server tuning for {@link Toki.listen} */
export interface ServerOptions {
  /** default `"0.0.0.0"` */
  host?: string;
  /** default 1 MiB */
  maxBodyBytes?: number;
  /** close a stalled (no-data) connection after this; 0 disables */
  headerTimeoutMs?: number;
  /** default 128 */
  maxHeaders?: number;
  /** pending-connection queue, default 512 */
  backlog?: number;
  /** per-connection unflushed-write ceiling in bytes; a peer that stops reading while the
   *  server keeps producing is dropped past this rather than buffered without bound.
   *  Default 16 MiB. */
  maxWriteQueue?: number;
  /** `SO_REUSEPORT` so workers can share the port (kernel-balanced; Linux/BSD) */
  reusePort?: boolean;
  /** bind a unix-domain socket at this path instead of TCP (the port is ignored) */
  unixPath?: string;
  /** dispatch unmatched routes to JS; set automatically when a not-found handler exists */
  notFound?: boolean;
  /** native per-IP limit: `max` per `windowMs`, over-limit gets a native 429 before JS */
  rateLimit?: { max: number; windowMs: number };
  /** @internal flattened {@link ServerOptions.rateLimit} */
  rateLimitMax?: number;
  /** @internal */
  rateLimitWindowMs?: number;
  /** largest accepted WebSocket message in bytes; default 16 MiB */
  maxWsMessageBytes?: number;
  /** offer permessage-deflate (RFC 7692) when a client requests it */
  wsCompression?: boolean;
  /**
   * Serve HTTP/2. Over TLS it is negotiated via ALPN (`h2`), falling back to HTTP/1.1
   * for clients that don't offer it; in cleartext it accepts the h2c prior-knowledge
   * preface. Multiplexing, flow control, and HPACK run in native code; handlers are
   * unchanged. TLS is recommended — most clients only speak h2 over TLS.
   */
  http2?: boolean;
  /** Cleartext HTTP/2 mode. `"multiplex"` (default) serves h2c and HTTP/1.1 on the same
   *  port — a connection is HTTP/2 only if it opens with the h2c preface. `"exclusive"`
   *  serves h2c only: a non-preface connection gets a `GOAWAY` and is closed, for
   *  prior-knowledge-only deployments (gRPC, pure-h2 internal services). Ignored over TLS,
   *  where ALPN selects the protocol. */
  http2Cleartext?: "multiplex" | "exclusive";
  /** h2 per-stream receive window we advertise (`SETTINGS_INITIAL_WINDOW_SIZE`); also the
   *  connection window we raise to. Larger lifts upload throughput at some memory cost.
   *  Default 256 KiB. */
  http2InitialWindow?: number;
  /** h2 `SETTINGS_MAX_CONCURRENT_STREAMS` — caps simultaneous streams per connection, the
   *  main per-connection memory bound. Default 128. */
  http2MaxConcurrentStreams?: number;
  /**
   * Terminate HTTPS directly (no reverse proxy). PEM cert chain (leaf first) +
   * private key — RSA or EC. TLS 1.3 only (AEAD suites).
   */
  tls?: { cert: string | Uint8Array; key: string | Uint8Array };
  /** @internal flattened cert PEM from {@link ServerOptions.tls} */
  tlsCert?: Uint8Array;
  /** @internal flattened key PEM from {@link ServerOptions.tls} */
  tlsKey?: Uint8Array;
}

/**
 * Native WebSocket event sink. `event`: 0 open (`a` = {@link NativeRequest},
 * `b` = subprotocol, `c` = 1 when permessage-deflate negotiated), 1 message
 * (`a` = flags: bit0 binary / bit1 compressed, `b` = payload), 2 close (`a` = code,
 * `b` = reason), 3 ping / 4 pong (`b` = payload), 5 drain. Buffers are valid only
 * for the duration of the call.
 */
export type WsDispatch = (wsId: number, event: number, a: unknown, b: unknown, c: unknown) => void;

interface Native {
  /**
   * Serve routes (parallel `methods`/`paths`) plus `staticEntries`. `dispatch` returns a
   * {@link NativeResponse} for sync, or `undefined` to defer to {@link Native.submitResponse};
   * a GET/HEAD route miss falls back to the static table.
   */
  listen(
    port: number,
    methods: string[],
    paths: string[],
    dispatch: (req: NativeRequest) => NativeResponse | undefined,
    staticEntries: StaticEntry[],
    options: ServerOptions,
    wsDispatch: WsDispatch,
    wsRouteIndices: number[],
    wsProtocols: string[],
  ): number;
  /** complete a deferred handler */
  submitResponse(dispatchId: number, response: NativeResponse): void;
  /** begin a chunked response; writes the head */
  startStream(dispatchId: number, status: number, headers: string): void;
  /** write one chunk; returns queued-byte backlog, or -1 if the connection is gone */
  writeStreamChunk(dispatchId: number, chunk: Uint8Array): number;
  /** terminating chunk, then resume/close the connection */
  endStream(dispatchId: number): void;
  /** send a WebSocket frame (`compressed` sets RSV1); returns the write backlog in bytes */
  wsSend(wsId: number, isBinary: number, data: Uint8Array, compressed: number): number;
  /** send a ping; the peer answers with a pong */
  wsPing(wsId: number, data: Uint8Array): void;
  /** send an unsolicited pong (heartbeat) */
  wsPong(wsId: number, data: Uint8Array): void;
  /** send a close frame with `code` and tear the connection down */
  wsClose(wsId: number, code: number): void;
  /** stop accepting and close every live connection */
  close(): void;

  /** start a raw TCP server; `dispatch(id, event, arg)` fires per connection lifecycle event */
  tcpListen(port: number, host: string, options: TcpOptions, dispatch: TcpDispatch): number;
  /** open an outbound TCP/TLS connection; returns the connection id synchronously (0 on an
   *  immediate failure). Resolution is async via `dispatch`: ev_connection on success, ev_close
   *  with a connect-reason code on failure. Shares the dispatcher/id space with `tcpListen`. */
  tcpConnect(host: string, port: number, options: TcpOptions, dispatch: TcpDispatch): number;
  /** write to a TCP connection; returns the queued-byte backlog (0 when flushed) */
  tcpSend(id: number, data: Uint8Array): number;
  /** peer address (+ TLS `authorized`) of a connection, read lazily on first access;
   *  `undefined` once the connection has closed */
  tcpPeer(id: number): RemoteInfo | undefined;
  /** RFC 8446 §7.5 keying-material exporter for a TLS connection; `undefined` on a plaintext or
   *  not-yet-established or unknown socket. `length` bytes from `label` (+ optional `context`). */
  tcpExportKeyingMaterial(
    id: number,
    length: number,
    label: string,
    context: Uint8Array | undefined,
  ): Buffer | undefined;
  /** the peer's leaf certificate in DER for a TLS connection; `undefined` on plaintext / not yet
   *  established / no peer certificate retained */
  tcpPeerCertificate(id: number): Buffer | undefined;
  /** the negotiated ALPN protocol for a TLS connection; `undefined` on plaintext / not yet
   *  established / none negotiated */
  tcpAlpnProtocol(id: number): string | undefined;
  /** the SNI host name a server connection's client requested; `undefined` on plaintext / not yet
   *  established / no SNI / a client connection */
  tcpServerName(id: number): string | undefined;
  /** stop reading from a TCP connection (backpressure); queued writes still flush */
  tcpPause(id: number): void;
  /** resume reading after a pause */
  tcpResume(id: number): void;
  /** stop accepting new connections; live ones keep running */
  tcpStopAccepting(): void;
  /** hot-reload the server's TLS config (cert/key, mTLS CA, ALPN, SNI) from the flattened options;
   *  new handshakes use it, established connections keep their session. Throws on a bad cert/key */
  tcpSetTls(options: TcpOptions): boolean;
  /** half-close a TCP connection: flush queued writes, then send FIN */
  tcpEnd(id: number): void;
  /** drop a TCP connection now */
  tcpClose(id: number): void;
  /** stop accepting and close every live TCP connection */
  tcpCloseServer(): void;

  // io_uring TCP backend (Linux only; each throws elsewhere). Same contract as the
  // libuv tcp* functions above — selected by the `engine` server option.
  tcpUringListen(port: number, host: string, options: TcpOptions, dispatch: TcpDispatch): number;
  tcpUringSend(id: number, data: Uint8Array): number;
  tcpUringPeer(id: number): RemoteInfo | undefined;
  tcpUringEnd(id: number): void;
  tcpUringClose(id: number): void;
  tcpUringCloseServer(): void;
  /** whether io_uring will actually work here (Linux, kernel new enough, syscalls not
   *  blocked by a container sandbox) — probed by setting up a throwaway ring */
  tcpUringAvailable(): boolean;

  /** bind a UDP socket; `dispatch(data, rinfo)` fires per received datagram */
  udpBind(port: number, host: string, options: UdpOptions, dispatch: UdpDispatch): number;
  /** send a datagram to `host:port` */
  udpSend(data: Uint8Array, port: number, host: string): void;
  /** stop receiving and close the UDP socket */
  udpClose(): void;
}

/** native TCP event tags (match src/net/tcp.zig) */
export type TcpEvent = 0 | 1 | 2 | 3 | 4; // connection | data | drain | close | end
/** TCP lifecycle callback. `arg` is a buffer on data, a close-reason code (number) on close,
 *  else undefined (peer info is fetched lazily via {@link Native.tcpPeer}). */
export type TcpDispatch = (
  id: number,
  event: TcpEvent,
  arg: Uint8Array | number | undefined,
) => void;
/** UDP datagram callback */
export type UdpDispatch = (data: Uint8Array, rinfo: RemoteInfo) => void;

/** peer address of a TCP connection or the sender of a UDP datagram */
export interface RemoteInfo {
  readonly address: string;
  readonly port: number;
  /** TLS connections only: whether the peer presented a client cert that verified against
   *  the server's `ca`. Absent on plaintext connections. */
  readonly authorized?: boolean;
}

/** {@link Native.tcpListen} tuning */
export interface TcpOptions {
  /** `SO_REUSEPORT` so workers can share the port (Linux/BSD) */
  reusePort?: boolean;
  /** Nagle's algorithm; default off (low latency) */
  noDelay?: boolean;
  /** pending-connection queue. Default 512 */
  backlog?: number;
  /** maximum concurrent connections; a new accept past it is reset. Default 0 (unlimited) */
  maxConnections?: number;
  /** enable SO_KEEPALIVE on accepted sockets */
  keepAlive?: boolean;
  /** idle seconds before the first keepalive probe (with `keepAlive`) */
  keepAliveDelaySecs?: number;
  /** close a connection idle (no read or write) for this many ms. Default 0 (off) */
  idleTimeoutMs?: number;
  /** close a TLS connection whose handshake hasn't established within this many ms. Default 0 (off) */
  handshakeTimeoutMs?: number;
  /** per-connection send-backlog ceiling in bytes; a connection that exceeds it (a
   *  non-reading peer plus a producer ignoring backpressure) is dropped. Default 16 MiB. */
  maxWriteQueue?: number;
  /** how often (ms) to re-poll for a peer's FIN/RST that the OS left pending while the loop
   *  was idle. macOS kqueue can otherwise sit on it for seconds. Default 50; 0 disables. */
  eofPollMs?: number;
  /** @internal flattened {@link TcpServerOptions.rateLimit} — accepts per IP per window */
  rateLimitMax?: number;
  /** @internal flattened {@link TcpServerOptions.rateLimit} window in ms */
  rateLimitWindowMs?: number;
  /** @internal flattened cert PEM from the TCP server's `tls` option */
  tlsCert?: Uint8Array;
  /** @internal flattened key PEM from the TCP server's `tls` option */
  tlsKey?: Uint8Array;
  /** @internal flattened client-CA PEM from the TCP server's `tls.ca` — enables mTLS */
  tlsClientCa?: Uint8Array;
  /** @internal `tls.requestCert && tls.rejectUnauthorized`: fail the handshake on a
   *  missing/untrusted client cert (.require) rather than just request one (.request) */
  tlsRequireClient?: boolean;
  /** @internal {@link TcpConnectOptions.timeoutMs}: fail an outbound connect/handshake after ms */
  timeoutMs?: number;
  /** @internal terminate TLS as the client on an outbound connect */
  tlsClient?: boolean;
  /** @internal SNI + the name the server cert is verified against (defaults to the host) */
  tlsServerName?: string;
  /** @internal PEM CA bundle to trust on a client connect instead of the system roots */
  tlsCa?: Uint8Array;
  /** @internal skip server-cert verification on a client connect (unsafe; test/self-signed) */
  tlsInsecure?: boolean;
  /** @internal ALPN protocol list in wire format (each: 1-byte length + bytes) — offered by a
   *  server (listen) or a client (connect) */
  tlsAlpn?: Uint8Array;
  /** @internal SNI virtual-host certificates: a cert/key the server presents when the client's
   *  requested host name matches `servername` (an exact host or a `*.` wildcard) */
  tlsSni?: Array<{ servername: string; cert: Uint8Array; key: Uint8Array }>;
}

/** {@link Native.udpBind} tuning */
export interface UdpOptions {
  /** `SO_REUSEADDR` */
  reuseAddr?: boolean;
  /** batch reads with `recvmmsg` (Linux) */
  recvmmsg?: boolean;
  /** @internal flattened {@link UdpServerOptions.rateLimit} — datagrams per source per window */
  rateLimitMax?: number;
  /** @internal flattened {@link UdpServerOptions.rateLimit} window in ms */
  rateLimitWindowMs?: number;
}

// Detects musl libc (Alpine) so Linux picks the right package. glibc exposes
// glibcVersionRuntime in the process report; musl does not.
function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: unknown }; sharedObjects?: unknown[] }
      | undefined;
    if (report?.header?.glibcVersionRuntime) return false;
    if (Array.isArray(report?.sharedObjects)) {
      return report.sharedObjects.some(
        (o) => typeof o === "string" && (o.includes("libc.musl-") || o.includes("ld-musl-")),
      );
    }
  } catch {
    // fall through to glibc default
  }
  return false;
}

// process.platform/arch → the package + filename suffix the release builds publish.
function nativeTriple(): string {
  const { platform, arch } = process;
  if (platform === "win32") return `win32-${arch}-msvc`;
  if (platform === "darwin") return `darwin-${arch}`;
  if (platform === "freebsd") return `freebsd-${arch}`;
  if (platform === "linux") {
    if (arch === "arm") return "linux-arm-gnueabihf";
    return `linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
  }
  return `${platform}-${arch}`;
}

// Local source build (zig-out) first, then a binary bundled beside the loader, then
// the per-platform npm package installed as an optional dependency.
function loadNative(): Native {
  const triple = nativeTriple();
  const attempts: Array<readonly [string, () => unknown]> = [
    ["zig-out/toki.node", () => require(join(root, "zig-out", "toki.node"))],
    [`toki.${triple}.node`, () => require(join(root, `toki.${triple}.node`))],
    [`@usetoki/toki-${triple}`, () => require(`@usetoki/toki-${triple}`)],
  ];
  const errors: string[] = [];
  for (const [name, load] of attempts) {
    try {
      return load() as Native;
    } catch (error) {
      errors.push(`  ${name}: ${(error as Error).message}`);
    }
  }
  throw new Error(
    `toki: no native binary for ${process.platform}-${process.arch}. Tried:\n${errors.join("\n")}\n` +
      "Use a supported platform, or build from source with `npm run build`.",
  );
}

export const native: Native = loadNative();
