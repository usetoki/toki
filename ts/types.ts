import type { Toki } from "./app";
import type { StaticMount } from "./binding";
import type { TokiRequest } from "./request";
import type { TokiResponse } from "./response";

/** The well-known HTTP methods with dedicated registration helpers ({@link Toki.get}, ...). */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * A method accepted when registering a route: a well-known {@link Method} or any verb string.
 *
 * The `(string & {})` member keeps the literal union visible in completions while still
 * admitting any string, rather than collapsing to `string`.
 */
export type RouteMethod = Method | (string & {});

/** A value that may or may not be wrapped in a {@link Promise}. */
export type MaybePromise<T> = T | Promise<T>;

/** A request handler: maps a {@link TokiRequest} to a {@link TokiResponse}, sync or async. */
export type Handler = (request: TokiRequest) => MaybePromise<TokiResponse>;

/** Options accepted by {@link Toki.listen}. */
export interface ListenOptions {
  /** Port to bind to. Use `0` to let the OS choose a free port. */
  readonly port: number;
  /** Interface to bind to. Defaults to `127.0.0.1`. */
  readonly host?: string;
  /** Tokio runtime size. `1` runs single-threaded; omit for one worker per CPU core. */
  readonly workerThreads?: number;

  /** Max request head (request line + headers) size, in bytes. Default 65536. */
  readonly maxHeaderBytes?: number;

  /** Max request body size for JS-handled routes, in bytes. Default 16777216 (16 MiB). */
  readonly maxBodyBytes?: number;

  /** Max number of headers per request. Clamped to a ceiling of 128. Default 64. */
  readonly maxHeaders?: number;

  /** Initial per-connection read buffer, in bytes. Grows on demand. Default 2048. */
  readonly readBufferBytes?: number;

  /** How long a single read may stall before the connection is dropped, in ms. `0` disables. Default 30000. */
  readonly readTimeoutMs?: number;

  /** How long graceful shutdown waits for in-flight connections to drain, in ms. `0` waits forever. Default 10000. */
  readonly shutdownTimeoutMs?: number;

  /** Bind a Unix-domain socket at this path instead of TCP. `host`/`port` are ignored; the resolved port is `0`. */
  readonly unixPath?: string;

  /** PEM certificate chain. With `tlsKey`, accepted TCP connections are TLS-wrapped (HTTPS). */
  readonly tlsCert?: string;

  /** PEM private key matching `tlsCert`. Required to enable TLS. */
  readonly tlsKey?: string;

  /** Set `TCP_NODELAY` on accepted TCP connections (lower latency). No effect on Unix sockets. Default `true`. */
  readonly tcpNodelay?: boolean;

  /**
   * Parse `application/x-www-form-urlencoded` and `multipart/form-data` bodies natively for
   * JS-handled routes, delivering the result as {@link TokiRequest.form}. Default `false`.
   */
  readonly parseForms?: boolean;

  /**
   * Max size of a single uploaded file, in bytes; an over-size part is rejected with a native
   * `413`. `0`/omitted is unlimited. Only consulted when `parseForms` is on.
   */
  readonly maxFileSize?: number;

  /**
   * Allow-list of upload extensions, lowercase and dotless (e.g. `["png", "jpg"]`); others are
   * rejected with a native `415`. Omitted allows all. Requires `parseForms`.
   */
  readonly allowedFileExtensions?: string[];

  /**
   * Directory uploads are written to, reported as `path`; unset returns bytes
   * inline in `data`. Requires `parseForms`.
   */
  readonly uploadDir?: string;

  /**
   * Static-file mounts served entirely in Rust, checked after native routes and before the
   * dynamic router. Prefer {@link Toki.static}; mounts passed here are applied after those.
   */
  readonly staticMounts?: readonly StaticMount[];

  /**
   * Negotiate response compression against `Accept-Encoding` (preferring `br`, then `gzip`) for
   * compressible bodies at least `compressionMinSize` bytes. Default `false`.
   */
  readonly compression?: boolean;

  /** Minimum body size, in bytes, before compression is attempted. Default 1024. */
  readonly compressionMinSize?: number;

  /**
   * Headers injected into every response (native, static, dynamic) unless already present. Given
   * as a name→value map; converted to the native `{ name, value }[]` shape when forwarded.
   */
  readonly defaultHeaders?: Record<string, string>;

  /** gzip level for compressed responses (0–9). Default 6. Only used when `compression` is on. */
  readonly gzipLevel?: number;

  /** brotli quality for per-request compression (0–11). Default 5 (latency/ratio balance). */
  readonly brotliQuality?: number;

  /** brotli window size, log base 2 (10–24). Default 22. */
  readonly brotliWindow?: number;

  /** brotli quality for one-time native-route pre-compression (0–11). Default 11 (max; cost paid once). */
  readonly brotliQualityStatic?: number;

  /**
   * `X-Powered-By` header sent on every response. Omitted sends `Toki`; a string replaces it;
   * `false` removes it. An `x-powered-by` entry in `defaultHeaders` takes precedence.
   */
  readonly poweredBy?: string | false;
}

/** A running server, returned once {@link Toki.listen} resolves. */
export interface ListenHandle {
  readonly host: string;
  /** The port actually bound (resolved when `port: 0` was requested). */
  readonly port: number;
  /** Stop accepting new connections. Idempotent. */
  close(): void;
}
