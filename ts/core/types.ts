import type { TokiRequest } from "../http/request.js";
import type { RouteSchema } from "../http/schema.js";

/** Methods toki routes natively. Any token is accepted via {@link Toki.route}. */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** A plain value a handler may return; sent as JSON (serialized via the response schema when one is set). */
export type JsonResult = Record<string, unknown> | unknown[] | number | boolean | null;

/** Handler response; build with {@link reply}. Engine adds the status line, `Content-Length`, `Connection`. */
export interface TokiResponse {
  readonly status: number;
  readonly contentType: string;
  /** Extra headers beyond `Content-Type`, e.g. `Set-Cookie` or `Location`. */
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  /** Text or raw bytes (e.g. an image or a compressed payload). */
  readonly body: string | Uint8Array;
}

/** Bytes (or UTF-8 strings) a streaming response yields over time. */
export type StreamSource = AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;

/**
 * Streaming response (`reply.stream`): head, then each chunk via `Transfer-Encoding: chunked`.
 * Bypasses response hooks and serialization — no materialized body.
 */
export interface StreamResponse {
  readonly status: number;
  readonly contentType: string;
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  readonly source: StreamSource;
}

/** A handler's result: a response, a stream, a string (`reply.text`), or a value sent as JSON. */
export type HandlerResult = TokiResponse | StreamResponse | string | JsonResult;

/** A request handler. May be synchronous or `async`. */
export type Handler = (req: TokiRequest) => HandlerResult | Promise<HandlerResult>;

/** Per-route options: validation schema and route-scoped hooks. */
export interface RouteOptions {
  schema?: RouteSchema;
  preValidation?: Middleware | Middleware[];
  preHandler?: Middleware | Middleware[];
  preSerialization?: SerializationHook | SerializationHook[];
  /** Arbitrary per-route data, reachable via `req` decorators or hooks. */
  config?: Record<string, unknown>;
}

/** App lifecycle callbacks (`onReady` at listen, `onClose` at shutdown). */
export type LifecycleHook = () => void | Promise<void>;

/** Options passed to `register`. `prefix` mounts the plugin's routes under a path. */
export interface PluginOptions {
  prefix?: string;
  [key: string]: unknown;
}

/** Pre-handler step. Return a response to short-circuit (skips handler + remaining steps); nothing to continue. */
export type Middleware = (req: TokiRequest) => HandlerResult | void | Promise<HandlerResult | void>;

/** Runs after the handler; may replace the response by returning a new one. */
export type ResponseHook = (
  req: TokiRequest,
  res: TokiResponse,
) => HandlerResult | void | Promise<HandlerResult | void>;

/** Runs on a plain handler return (not a built `reply`), just before JSON encoding. Returns the payload to serialize. */
export type SerializationHook = (req: TokiRequest, payload: unknown) => unknown | Promise<unknown>;

/** Handles an error thrown anywhere in the pipeline. */
export type ErrorHandler = (req: TokiRequest, error: unknown) => HandlerResult;

/** Runs when a request exceeds `requestTimeoutMs` (the engine then replies `408`). */
export type TimeoutHook = (req: TokiRequest) => void | Promise<void>;

/** Parses a raw request body (by content type) into a value, for `req.parseBody()`. */
export type BodyParser = (req: TokiRequest, body: Uint8Array) => unknown | Promise<unknown>;

/** A registered content-type parser: a content-type test and the parser to run. */
export interface ContentTypeParserEntry {
  readonly test: (contentType: string) => boolean;
  readonly parser: BodyParser;
}

/** Lifecycle hook points. `preParsing` runs right after `onRequest`; `preValidation`
 * runs before schema validation; `preSerialization` runs before a plain value is
 * JSON-encoded; `onSend` runs after `onResponse`, last before the bytes go out;
 * `onTimeout` runs when a request exceeds `requestTimeoutMs`. */
export type HookName =
  | "onRequest"
  | "preParsing"
  | "preValidation"
  | "preHandler"
  | "preSerialization"
  | "onResponse"
  | "onSend"
  | "onTimeout";

/** Minimal structured logger. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface TokiOptions {
  /** A {@link Logger}, a level for the built-in console logger, or `false`/omitted for silence. */
  logger?: Logger | LogLevel | false;
  /** Reply `408` (and run `onTimeout` hooks) if an async handler runs longer than this (ms). 0/omitted = off. */
  requestTimeoutMs?: number;
}

/** Returned by `listen`; `close()` stops the server. */
export interface ListenHandle {
  close(): void;
}
