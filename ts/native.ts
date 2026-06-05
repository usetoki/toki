// sole entry point to the Zig addon
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  /** dispatch unmatched routes to JS; set automatically when a not-found handler exists */
  notFound?: boolean;
  /** native per-IP limit: `max` per `windowMs`, over-limit gets a native 429 before JS */
  rateLimit?: { max: number; windowMs: number };
  /** @internal flattened {@link ServerOptions.rateLimit} */
  rateLimitMax?: number;
  /** @internal */
  rateLimitWindowMs?: number;
}

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
  ): number;
  /** complete a deferred handler */
  submitResponse(dispatchId: number, response: NativeResponse): void;
  /** begin a chunked response; writes the head */
  startStream(dispatchId: number, status: number, headers: string): void;
  /** write one chunk; returns queued-byte backlog, or -1 if the connection is gone */
  writeStreamChunk(dispatchId: number, chunk: Uint8Array): number;
  /** terminating chunk, then resume/close the connection */
  endStream(dispatchId: number): void;
  /** stop accepting and close every live connection */
  close(): void;
}

export const native: Native = require(join(root, "zig-out", "toki.node")) as Native;
