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
   * Terminate HTTPS directly (no reverse proxy). PEM cert chain (leaf first) +
   * private key — RSA or EC. AEAD suites only, TLS 1.2 + 1.3.
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
  /** write to a TCP connection; returns the queued-byte backlog (0 when flushed) */
  tcpSend(id: number, data: Uint8Array): number;
  /** half-close a TCP connection: flush queued writes, then send FIN */
  tcpEnd(id: number): void;
  /** drop a TCP connection now */
  tcpClose(id: number): void;
  /** stop accepting and close every live TCP connection */
  tcpCloseServer(): void;

  /** bind a UDP socket; `dispatch(data, rinfo)` fires per received datagram */
  udpBind(port: number, host: string, options: UdpOptions, dispatch: UdpDispatch): number;
  /** send a datagram to `host:port` */
  udpSend(data: Uint8Array, port: number, host: string): void;
  /** stop receiving and close the UDP socket */
  udpClose(): void;
}

/** native TCP event tags (match src/net/tcp.zig) */
export type TcpEvent = 0 | 1 | 2 | 3; // connection | data | drain | close
/** TCP lifecycle callback. `arg` is a {@link RemoteInfo} on connection, a buffer on data, else undefined */
export type TcpDispatch = (
  id: number,
  event: TcpEvent,
  arg: RemoteInfo | Uint8Array | undefined,
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
  /** per-connection send-backlog ceiling in bytes; a connection that exceeds it (a
   *  non-reading peer plus a producer ignoring backpressure) is dropped. Default 16 MiB. */
  maxWriteQueue?: number;
  /** how often (ms) to re-poll for a peer's FIN/RST that the OS left pending while the loop
   *  was idle. macOS kqueue can otherwise sit on it for seconds. Default 50; 0 disables. */
  eofPollMs?: number;
  /** @internal flattened cert PEM from the TCP server's `tls` option */
  tlsCert?: Uint8Array;
  /** @internal flattened key PEM from the TCP server's `tls` option */
  tlsKey?: Uint8Array;
  /** @internal flattened client-CA PEM from the TCP server's `tls.ca` — enables mTLS */
  tlsClientCa?: Uint8Array;
  /** @internal `tls.requestCert && tls.rejectUnauthorized`: fail the handshake on a
   *  missing/untrusted client cert (.require) rather than just request one (.request) */
  tlsRequireClient?: boolean;
}

/** {@link Native.udpBind} tuning */
export interface UdpOptions {
  /** `SO_REUSEADDR` */
  reuseAddr?: boolean;
  /** batch reads with `recvmmsg` (Linux) */
  recvmmsg?: boolean;
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
