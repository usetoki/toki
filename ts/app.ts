import {
  nativeListen,
  type DynamicRoute,
  type HttpHeader,
  type HttpRequest,
  type HttpResponse,
  type NativeRoute,
  type ServerHandle,
  type ServerOptions,
  type StaticMount,
} from "./binding";
import { RouteGroup, type RouteSink } from "./group";
import {
  composeRouteHooks,
  createHookStore,
  type HookSignatures,
  type HookStore,
  type Middleware,
  type PreHook,
  type ResponseHook,
  type RouteHooks,
} from "./hooks";
import { resolveLogger, type Logger, type LoggerOption } from "./logger";
import { NativeRegistrar } from "./native";
import { TokiRequest } from "./request";
import { reply, toNative, type TokiResponse } from "./response";
import { normalizePattern } from "./router";
import type { Handler, ListenHandle, ListenOptions, MaybePromise, RouteMethod } from "./types";

// Stored at the same index as its DynamicRoute, so a native routeIndex selects both in one lookup.
interface DynamicHandler {
  readonly handler: Handler;
  // Composed once at registration so dispatch never recomposes per request.
  readonly hooks: RouteHooks;
  // A synthesized auto-HEAD mirror of a GET route: the handler runs, but the dispatcher drops the body.
  readonly autoHead: boolean;
}

/** Handles anything a handler (or the native layer) throws; returns the response to send. */
export type ErrorHandler = (
  error: unknown,
  request: TokiRequest | null,
) => MaybePromise<TokiResponse>;

/** Options accepted by the {@link Toki} constructor. */
export interface TokiOptions {
  /** Silent if omitted; `true` enables a JSON console logger; a level or {@link Logger} is honored. */
  logger?: LoggerOption;
}

const DEFAULT_HOST = "127.0.0.1";

/**
 * A Toki application. Register routes, then call {@link Toki.listen}; the Tokio runtime accepts
 * connections and calls back into your handlers. Registration methods return `this` for chaining.
 *
 * ```ts
 * const app = new Toki({ logger: true });
 * app.use(securityHeaders());
 * app.addHook("onRequest", (req) => { req.log.info("incoming"); });
 * app.get("/", () => reply.text("hello"));
 * app.get("/users/:id", (req) => reply.json({ id: req.params.id }));
 * app.group("/api", (api) => {
 *   api.use(cors());
 *   api.get("/health", () => reply.json({ ok: true }));
 * });
 * await app.listen({ port: 3000 });
 * ```
 *
 * Each dynamic-route request runs `onRequest` hooks → `use` middleware → `preHandler` hooks →
 * handler → `onResponse` hooks (root before group at each stage). Any pre-handler step may
 * short-circuit with a {@link TokiResponse}; anything thrown routes to {@link Toki.onError}; staged
 * response headers are merged before `onResponse`. The native fast path (`app.native.*`) bypasses all of it.
 */
export class Toki {
  readonly #nativeRoutes: NativeRoute[] = [];
  // Handed verbatim to nativeListen; the native router reports a match as HttpRequest.routeIndex.
  readonly #dynamicRoutes: DynamicRoute[] = [];
  // Parallel to #dynamicRoutes (same index), so one routeIndex selects both pattern and handler.
  readonly #handlers: DynamicHandler[] = [];
  // `method + " " + pattern` keys already registered; gates auto-HEAD and duplicate inserts.
  readonly #dynamicKeys = new Set<string>();
  readonly #staticMounts: StaticMount[] = [];
  readonly #hooks: HookStore = createHookStore();
  readonly #logger: Logger;
  #handle: ServerHandle | null = null;
  #errorHandler: ErrorHandler = (error) => {
    this.#logger.error({ err: serializeError(error) }, "unhandled error in request handler");
    return reply.text("Internal Server Error", { status: 500 });
  };

  /** Routes answered entirely in Rust, never crossing into JavaScript. Use for hot paths. */
  readonly native = new NativeRegistrar(this.#nativeRoutes);

  constructor(options: TokiOptions = {}) {
    this.#logger = resolveLogger(options.logger);
  }

  /** Register a `GET` handler, e.g. `app.get("/users/:id", handler)`. */
  get(path: string, handler: Handler): this {
    return this.#register("GET", path, handler);
  }

  /** Register a `POST` handler. */
  post(path: string, handler: Handler): this {
    return this.#register("POST", path, handler);
  }

  /** Register a `PUT` handler. */
  put(path: string, handler: Handler): this {
    return this.#register("PUT", path, handler);
  }

  /** Register a `PATCH` handler. */
  patch(path: string, handler: Handler): this {
    return this.#register("PATCH", path, handler);
  }

  /** Register a `DELETE` handler. */
  delete(path: string, handler: Handler): this {
    return this.#register("DELETE", path, handler);
  }

  /** Register a `HEAD` handler. */
  head(path: string, handler: Handler): this {
    return this.#register("HEAD", path, handler);
  }

  /** Register an `OPTIONS` handler. */
  options(path: string, handler: Handler): this {
    return this.#register("OPTIONS", path, handler);
  }

  /** Register a handler for an arbitrary method, e.g. `"PURGE"` (see {@link RouteMethod}). */
  route(method: RouteMethod, path: string, handler: Handler): this {
    return this.#register(method, path, handler);
  }

  /**
   * Serve files from `dir` under `urlPrefix` entirely in Rust (MIME, `ETag`/`304`, `Range`),
   * checked after native routes and before the dynamic router; first matching prefix wins.
   *
   * ```ts
   * app.static("/static", "/var/www/assets");
   * app.static("/", "/var/www/public", { indexFile: "index.html" });
   * ```
   *
   * @param options `indexFile` (served for a directory) and `cacheControl` (default
   *   `public, max-age=3600`).
   */
  static(
    urlPrefix: string,
    dir: string,
    options: { indexFile?: string; cacheControl?: string } = {},
  ): this {
    // Field-by-field so omitted fields stay absent, not `undefined` (exactOptionalPropertyTypes).
    const mount: StaticMount = { urlPrefix, dir };
    if (options.indexFile !== undefined) mount.indexFile = options.indexFile;
    if (options.cacheControl !== undefined) mount.cacheControl = options.cacheControl;
    this.#staticMounts.push(mount);
    return this;
  }

  /**
   * Register an application-wide lifecycle hook (see the class docs for ordering). `onRequest`
   * and `preHandler` may short-circuit with a {@link TokiResponse}; `onResponse` may replace it.
   */
  addHook<K extends keyof HookSignatures>(name: K, fn: HookSignatures[K]): this {
    if (name === "onResponse") {
      this.#hooks.onResponse.push(fn as ResponseHook);
    } else if (name === "onRequest") {
      this.#hooks.onRequest.push(fn as PreHook);
    } else {
      this.#hooks.preHandler.push(fn as PreHook);
    }
    return this;
  }

  /** Register application-wide middleware; may short-circuit with a {@link TokiResponse}. */
  use(fn: Middleware): this {
    this.#hooks.middleware.push(fn);
    return this;
  }

  /**
   * Define a group of routes sharing a path prefix and scoped hooks/middleware.
   *
   * ```ts
   * app.group("/api/v1", (api) => {
   *   api.use(cors());
   *   api.addHook("preHandler", requireAuth);
   *   api.get("/users/:id", getUser);
   * });
   * ```
   */
  group(prefix: string, builder: (group: RouteGroup) => void): this {
    const group = new RouteGroup(this.#sink, prefix, [this.#hooks]);
    builder(group);
    return this;
  }

  // Shared with RouteGroups: every dynamic route funnels through #addDynamic for lockstep
  // arrays and uniform auto-HEAD, regardless of whether it came from the root or a group.
  readonly #sink: RouteSink = {
    add: (method, pattern, handler, scopes) => this.#addDynamic(method, pattern, handler, scopes),
  };

  /** Replace the handler invoked when a route or hook throws. Defaults to logging and a `500`. */
  onError(handler: ErrorHandler): this {
    this.#errorHandler = handler;
    return this;
  }

  /**
   * Bind and start serving; the returned promise resolves once the socket is bound.
   *
   * @returns A handle with the resolved host/port and `close`.
   * @throws {Error} If this instance is already listening.
   */
  async listen(options: ListenOptions): Promise<ListenHandle> {
    if (this.#handle) {
      throw new Error("server is already listening");
    }
    const host = options.host ?? DEFAULT_HOST;
    // Forward only the limits the caller set; field-by-field keeps omitted ones absent, not
    // `undefined` (exactOptionalPropertyTypes), so the native side applies its own defaults.
    const native: ServerOptions = {};
    if (options.workerThreads !== undefined) native.workerThreads = options.workerThreads;
    if (options.maxHeaderBytes !== undefined) native.maxHeaderBytes = options.maxHeaderBytes;
    if (options.maxBodyBytes !== undefined) native.maxBodyBytes = options.maxBodyBytes;
    if (options.maxHeaders !== undefined) native.maxHeaders = options.maxHeaders;
    if (options.readBufferBytes !== undefined) native.readBufferBytes = options.readBufferBytes;
    if (options.readTimeoutMs !== undefined) native.readTimeoutMs = options.readTimeoutMs;
    if (options.shutdownTimeoutMs !== undefined)
      native.shutdownTimeoutMs = options.shutdownTimeoutMs;
    if (options.unixPath !== undefined) native.unixPath = options.unixPath;
    if (options.tlsCert !== undefined) native.tlsCert = options.tlsCert;
    if (options.tlsKey !== undefined) native.tlsKey = options.tlsKey;
    if (options.tcpNodelay !== undefined) native.tcpNodelay = options.tcpNodelay;
    if (options.parseForms !== undefined) native.parseForms = options.parseForms;
    if (options.maxFileSize !== undefined) native.maxFileSize = options.maxFileSize;
    if (options.allowedFileExtensions !== undefined)
      native.allowedFileExtensions = options.allowedFileExtensions;
    if (options.uploadDir !== undefined) native.uploadDir = options.uploadDir;
    if (options.compression !== undefined) native.compression = options.compression;
    if (options.compressionMinSize !== undefined)
      native.compressionMinSize = options.compressionMinSize;
    if (options.defaultHeaders !== undefined) {
      native.defaultHeaders = Object.entries(options.defaultHeaders).map(
        ([name, value]): HttpHeader => ({ name, value }),
      );
    }
    if (options.gzipLevel !== undefined) native.gzipLevel = options.gzipLevel;
    if (options.brotliQuality !== undefined) native.brotliQuality = options.brotliQuality;
    if (options.brotliWindow !== undefined) native.brotliWindow = options.brotliWindow;
    if (options.brotliQualityStatic !== undefined)
      native.brotliQualityStatic = options.brotliQualityStatic;
    // `false` disables the header (empty string to the native layer); a string overrides "Toki".
    if (options.poweredBy !== undefined) {
      native.poweredBy = options.poweredBy === false ? "" : options.poweredBy;
    }
    // app.static(...) mounts come first, then any passed inline via options.staticMounts.
    const mounts: StaticMount[] = [...this.#staticMounts, ...(options.staticMounts ?? [])];
    if (mounts.length > 0) native.staticMounts = mounts;
    const handle = nativeListen(
      host,
      options.port,
      this.#nativeRoutes,
      this.#dynamicRoutes,
      this.#dispatch,
      native,
    );
    this.#handle = handle;
    return { host, port: handle.port, close: () => this.close() };
  }

  /** Stop accepting new connections. Idempotent; safe to call when not listening. */
  close(): void {
    this.#handle?.close();
    this.#handle = null;
  }

  #register(method: RouteMethod, path: string, handler: Handler): this {
    this.#addDynamic(method, path, handler, [this.#hooks]);
    return this;
  }

  // Shared by the root and every RouteGroup so registration order — and thus routeIndex — agrees.
  #addDynamic(
    method: RouteMethod,
    path: string,
    handler: Handler,
    scopes: readonly HookStore[],
  ): void {
    const pattern = normalizePattern(path);
    this.#pushDynamic(method, pattern, handler, scopes, false);

    // The native router matches methods exactly, so mirror GET as HEAD (body dropped at dispatch)
    // unless an explicit HEAD exists; otherwise a HEAD to a GET-only route would 405.
    if (method === "GET" && !this.#dynamicKeys.has(`HEAD ${pattern}`)) {
      this.#pushDynamic("HEAD", pattern, handler, scopes, true);
    }
  }

  #pushDynamic(
    method: RouteMethod,
    pattern: string,
    handler: Handler,
    scopes: readonly HookStore[],
    autoHead: boolean,
  ): void {
    const key = `${method} ${pattern}`;
    // First registration wins, matching the native router (which ignores duplicate inserts);
    // skipping here keeps the parallel arrays index-aligned.
    if (this.#dynamicKeys.has(key)) {
      return;
    }
    this.#dynamicKeys.add(key);
    this.#dynamicRoutes.push({ method, pattern });
    this.#handlers.push({ handler, hooks: composeRouteHooks(scopes), autoHead });
  }

  /**
   * The callback handed to the native layer. Bound as a field so its `this` is
   * fixed when passed across the boundary.
   *
   * Invoked only on a route match — path misses (`404`) and method misses (`405`) are answered
   * natively and never reach here — with `raw.routeIndex` selecting the matched handler directly.
   *
   * Always resolves: a native error or a throwing handler/hook becomes an {@link HttpResponse}
   * rather than a rejection, so the Rust side never observes one.
   */
  readonly #dispatch = async (error: Error | null, raw: HttpRequest): Promise<HttpResponse> => {
    if (error) {
      return toNative(reply.text("Bad Request", { status: 400 }));
    }

    let request: TokiRequest | null = null;
    let autoHead = false;
    try {
      const entry = this.#handlers[raw.routeIndex];
      if (entry === undefined) {
        // A match should always have a handler; if the parallel arrays ever drift, fail closed.
        this.#logger.error({ routeIndex: raw.routeIndex }, "no handler for matched route index");
        return toNative(reply.text("Internal Server Error", { status: 500 }));
      }

      const log = this.#logger.child({ reqId: raw.requestId, method: raw.method, path: raw.path });
      request = new TokiRequest(raw, { log });
      autoHead = raw.method === "HEAD" && entry.autoHead;
      return toNative(await this.#runPipeline(request, entry, autoHead));
    } catch (caught) {
      let response = await this.#handleError(caught, request);
      if (autoHead) {
        response = { status: response.status, headers: response.headers, body: null };
      }
      return toNative(response);
    }
  };

  // autoHead: a HEAD served by an auto-HEAD mirror — the handler runs, its body is dropped.
  async #runPipeline(
    request: TokiRequest,
    entry: DynamicHandler,
    autoHead: boolean,
  ): Promise<TokiResponse> {
    const { hooks } = entry;
    let response = await this.#runPreStages(request, hooks, entry.handler);

    mergeStagedHeaders(request.stagedResponseHeaders, response.headers);

    for (const hook of hooks.onResponse) {
      const replacement = await hook(request, response);
      if (replacement) {
        response = replacement;
      }
    }

    if (autoHead) {
      response = { status: response.status, headers: response.headers, body: null };
    }
    return response;
  }

  // Runs onRequest, middleware, then preHandler in order; returns the first short-circuit, else the handler.
  async #runPreStages(
    request: TokiRequest,
    hooks: RouteHooks,
    handler: Handler,
  ): Promise<TokiResponse> {
    const short =
      (await runStage(request, hooks.onRequest)) ??
      (await runStage(request, hooks.middleware)) ??
      (await runStage(request, hooks.preHandler));
    return short ?? handler(request);
  }

  async #handleError(caught: unknown, request: TokiRequest | null): Promise<TokiResponse> {
    try {
      return await this.#errorHandler(caught, request);
    } catch (handlerError) {
      // The error handler itself threw; fall back to a 500 so the dispatch promise never rejects.
      this.#logger.error({ err: serializeError(handlerError) }, "error handler threw");
      return reply.text("Internal Server Error", { status: 500 });
    }
  }
}

// Run one pre-handler stage, returning the first short-circuit response or undefined to continue.
async function runStage(
  request: TokiRequest,
  stage: readonly PreHook[],
): Promise<TokiResponse | undefined> {
  for (const fn of stage) {
    const short = await fn(request);
    if (short) {
      return short;
    }
  }
  return undefined;
}

// A staged value applies only when the response hasn't set it (handler wins); set-cookie accumulates.
function mergeStagedHeaders(staged: Headers, target: Headers): void {
  staged.forEach((value, name) => {
    if (name === "set-cookie") {
      target.append(name, value);
    } else if (!target.has(name)) {
      target.set(name, value);
    }
  });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
