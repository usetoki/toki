import { joinPaths, RouteGroup } from "./group.js";
import { inject, type InjectOptions, type InjectResponse } from "./inject.js";
import { resolveLogger } from "./logger.js";
import { corsHeaders, corsPreflight, type CorsOptions } from "./middleware.js";
import {
  native,
  type NativeRequest,
  type NativeResponse,
  type ServerOptions,
  type StaticEntry,
} from "./native.js";
import {
  contentTypeMatcher,
  isThenable,
  materialize,
  runAfter,
  runBefore,
  runSerialization,
  validationStep,
} from "./pipeline.js";
import { TokiRequest } from "./request.js";
import { isStreamResponse, isTokiResponse, reply, toNative } from "./response.js";
import type { JSONSchema } from "./schema.js";
import { buildStaticEntries, type StaticOptions } from "./static.js";
import type {
  BodyParser,
  ContentTypeParserEntry,
  ErrorHandler,
  Handler,
  HandlerResult,
  HookName,
  LifecycleHook,
  ListenHandle,
  Logger,
  Middleware,
  PluginOptions,
  ResponseHook,
  RouteMethod,
  RouteOptions,
  SerializationHook,
  StreamResponse,
  TimeoutHook,
  TokiOptions,
} from "./types.js";

interface Route {
  readonly method: RouteMethod;
  readonly path: string;
  readonly handler: Handler;
  readonly options: RouteOptions;
  // by reference; spliced into the before-chain at listen
  readonly groupMiddleware: readonly Middleware[];
  // scope ancestry supplies the hook chains
  readonly scope: Scope;
}

// route with lifecycle chains resolved, indexed parallel to the native routes
interface CompiledRoute {
  readonly handler: Handler;
  readonly before: readonly Middleware[];
  readonly after: readonly ResponseHook[];
  readonly serialization: readonly SerializationHook[];
  readonly onTimeout: readonly TimeoutHook[];
  // nearest scope first
  readonly parsers: readonly ContentTypeParserEntry[];
  // merged across scope ancestry
  readonly decorators: Record<string, unknown>;
  // nearest-scope handler; undefined falls back to default
  readonly errorHandler?: ErrorHandler;
  readonly responseSchemas?: Record<number, JSONSchema>;
  // status for a non-`reply` result: 404 for not-found route, else 200
  readonly defaultStatus?: number;
}

interface PluginEntry {
  readonly plugin: TokiPlugin;
  readonly opts: PluginOptions;
  readonly scope: Scope;
}

/** Registers routes/hooks/decorators on the encapsulated `instance`. */
export type TokiPlugin = (instance: TokiInstance, opts: PluginOptions) => void | Promise<void>;

const NO_MIDDLEWARE: readonly Middleware[] = [];
// must match `not_found_index` in Zig
const NOT_FOUND_INDEX = 0xffffffff;
// pause a stream producer once the connection's write backlog passes this (1 MiB)
const STREAM_HIGH_WATER = 1 << 20;

function streamHeaderBlock(
  stream: StreamResponse,
  staged: ReadonlyArray<readonly [string, string]>,
): string {
  let headers = "";
  for (const [name, value] of staged) {
    headers += `${name}: ${value}\r\n`;
  }
  headers += `Content-Type: ${stream.contentType}\r\n`;
  for (const [name, value] of stream.headers) {
    headers += `${name}: ${value}\r\n`;
  }
  return headers;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * Encapsulated registration scope: own hooks, middleware, request decorators,
 * error handler, and path prefix. Routes here run the hook chains of this scope
 * and all ancestors. The root app ({@link Toki}) is itself a scope; {@link
 * Scope.register} creates children.
 */
export class Scope {
  readonly onRequest: Middleware[] = [];
  readonly preParsing: Middleware[] = [];
  readonly middleware: Middleware[] = [];
  readonly preValidation: Middleware[] = [];
  readonly preHandler: Middleware[] = [];
  readonly preSerialization: SerializationHook[] = [];
  readonly onResponse: ResponseHook[] = [];
  readonly onSend: ResponseHook[] = [];
  readonly onTimeout: TimeoutHook[] = [];
  readonly requestDecorators: Record<string, unknown> = {};
  readonly contentTypeParsers: ContentTypeParserEntry[] = [];
  readonly plugins: PluginEntry[] = [];
  errorHandler?: ErrorHandler;

  constructor(
    readonly parent: Scope | undefined,
    readonly prefix: string,
  ) {}

  get root(): Toki {
    return this.parent ? this.parent.root : (this as unknown as Toki);
  }

  get log(): Logger {
    return this.root._logger;
  }

  get(path: string, handler: Handler): this;
  get(path: string, options: RouteOptions, handler: Handler): this;
  get(path: string, a: RouteOptions | Handler, b?: Handler): this {
    return this.#add("GET", path, a, b);
  }
  post(path: string, handler: Handler): this;
  post(path: string, options: RouteOptions, handler: Handler): this;
  post(path: string, a: RouteOptions | Handler, b?: Handler): this {
    return this.#add("POST", path, a, b);
  }
  put(path: string, handler: Handler): this;
  put(path: string, options: RouteOptions, handler: Handler): this;
  put(path: string, a: RouteOptions | Handler, b?: Handler): this {
    return this.#add("PUT", path, a, b);
  }
  patch(path: string, handler: Handler): this;
  patch(path: string, options: RouteOptions, handler: Handler): this;
  patch(path: string, a: RouteOptions | Handler, b?: Handler): this {
    return this.#add("PATCH", path, a, b);
  }
  delete(path: string, handler: Handler): this;
  delete(path: string, options: RouteOptions, handler: Handler): this;
  delete(path: string, a: RouteOptions | Handler, b?: Handler): this {
    return this.#add("DELETE", path, a, b);
  }
  head(path: string, handler: Handler): this {
    return this.#add("HEAD", path, handler);
  }
  options(path: string, handler: Handler): this {
    return this.#add("OPTIONS", path, handler);
  }
  route(method: RouteMethod, path: string, handler: Handler): this {
    return this.#add(method, path, handler);
  }

  #add(method: RouteMethod, path: string, a: RouteOptions | Handler, b?: Handler): this {
    const [options, handler] = typeof a === "function" ? [{}, a] : [a, b as Handler];
    this.root._pushRoute({
      method,
      path: joinPaths(this.prefix, path),
      handler,
      options,
      groupMiddleware: NO_MIDDLEWARE,
      scope: this,
    });
    return this;
  }

  /** Add middleware; runs before every handler in this scope and descendants. */
  use(middleware: Middleware): this {
    this.middleware.push(middleware);
    return this;
  }

  /** Register a lifecycle hook scoped to this instance. */
  addHook(name: "onRequest" | "preParsing" | "preValidation" | "preHandler", fn: Middleware): this;
  addHook(name: "preSerialization", fn: SerializationHook): this;
  addHook(name: "onResponse" | "onSend", fn: ResponseHook): this;
  addHook(name: "onTimeout", fn: TimeoutHook): this;
  addHook(name: HookName, fn: Middleware | ResponseHook | SerializationHook | TimeoutHook): this {
    switch (name) {
      case "onResponse":
        this.onResponse.push(fn as ResponseHook);
        break;
      case "onSend":
        this.onSend.push(fn as ResponseHook);
        break;
      case "preParsing":
        this.preParsing.push(fn as Middleware);
        break;
      case "preValidation":
        this.preValidation.push(fn as Middleware);
        break;
      case "preHandler":
        this.preHandler.push(fn as Middleware);
        break;
      case "preSerialization":
        this.preSerialization.push(fn as SerializationHook);
        break;
      case "onTimeout":
        this.onTimeout.push(fn as TimeoutHook);
        break;
      default:
        this.onRequest.push(fn as Middleware);
    }
    return this;
  }

  /** Set the error handler for routes in this scope (alias: `onError`). */
  setErrorHandler(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }
  onError(handler: ErrorHandler): this {
    return this.setErrorHandler(handler);
  }

  /** Attach a property to every request handled in this scope. */
  decorateRequest(name: string, value: unknown): this {
    this.requestDecorators[name] = value;
    return this;
  }

  /**
   * Register a body parser for one or more content types, consulted by
   * `req.parseBody()`. `type` matches case-insensitively as a prefix (e.g.
   * `"application/xml"`), a `RegExp`, or `"*"` for any. A child scope overrides
   * an ancestor for the same type.
   */
  addContentTypeParser(type: string | string[] | RegExp, parser: BodyParser): this {
    const tests = Array.isArray(type) ? type : [type];
    for (const t of tests) {
      this.contentTypeParsers.push({ test: contentTypeMatcher(t), parser });
    }
    return this;
  }

  /** Attach a property to the application instance (app-global, not encapsulated). */
  decorate(name: string, value: unknown): this {
    this.root._decorate(name, value);
    return this;
  }

  /** Set the handler for unmatched routes (app-global). */
  setNotFoundHandler(handler: Handler): this {
    this.root._setNotFound(handler);
    return this;
  }

  /** Enable CORS: stage headers on every response and answer preflight `OPTIONS`. */
  cors(options: CorsOptions = {}): this {
    this.use(corsHeaders(options));
    this.options("/*", corsPreflight(options));
    return this;
  }

  /** Serve files under `dir` at `urlPrefix` (joined with this scope's prefix). */
  static(urlPrefix: string, dir: string, options?: StaticOptions): this {
    this.root._mountStatic(joinPaths(this.prefix, urlPrefix), dir, options);
    return this;
  }

  /** Register a prefixed group of routes with its own middleware. */
  group(prefix: string, build: (group: RouteGroup) => void): this {
    const group = new RouteGroup(prefix, (method, path, handler, middleware) => {
      this.root._pushRoute({
        method,
        path: joinPaths(this.prefix, path),
        handler,
        options: {},
        groupMiddleware: middleware,
        scope: this,
      });
    });
    build(group);
    return this;
  }

  /**
   * Register a plugin into a fresh child scope. The plugin receives that scope as
   * its `instance`; routes/hooks/decorators it adds are encapsulated there (and
   * inherited by its own children), not leaked to the parent. Async plugins load
   * during {@link Toki.ready}. `opts.prefix` mounts the plugin's routes under a path.
   */
  register(plugin: TokiPlugin, opts: PluginOptions = {}): this {
    const prefix = joinPaths(this.prefix, typeof opts.prefix === "string" ? opts.prefix : "/");
    this.plugins.push({ plugin, opts, scope: new Scope(this, prefix) });
    return this;
  }
}

/** The registration surface a plugin receives (the application or a child scope). */
export type TokiInstance = Scope;

/**
 * The application. Register routes (optionally with a validation schema and
 * route-scoped hooks), global hooks, middleware, and plugins, then
 * {@link Toki.listen}. The pipeline stays synchronous until a step returns a
 * `Promise`, keeping the common sync request on the fast path.
 */
export class Toki extends Scope {
  readonly #routes: Route[] = [];
  readonly #onReady: LifecycleHook[] = [];
  readonly #onClose: LifecycleHook[] = [];
  readonly #staticMounts: Array<{ prefix: string; dir: string; options?: StaticOptions }> = [];
  readonly #loggerInstance: Logger;
  readonly #requestTimeoutMs: number;
  #notFoundHandler?: Handler;
  #compiled: CompiledRoute[] = [];
  #compiledNotFound: CompiledRoute | undefined;
  #booted = false;
  #boundPort = 0;
  #listening = false;

  constructor(options: TokiOptions = {}) {
    super(undefined, "");
    this.#loggerInstance = resolveLogger(options.logger);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 0;
  }

  /** @internal */
  get _logger(): Logger {
    return this.#loggerInstance;
  }
  /** @internal */
  _pushRoute(route: Route): void {
    this.#routes.push(route);
  }
  /** @internal */
  _decorate(name: string, value: unknown): void {
    (this as Record<string, unknown>)[name] = value;
  }
  /** @internal */
  _setNotFound(handler: Handler): void {
    this.#notFoundHandler = handler;
  }
  /** @internal */
  _mountStatic(prefix: string, dir: string, options?: StaticOptions): void {
    this.#staticMounts.push({ prefix, dir, ...(options ? { options } : {}) });
  }

  /** Run `fn` once at {@link Toki.listen}, before serving. */
  onReady(fn: LifecycleHook): this {
    this.#onReady.push(fn);
    return this;
  }

  /** Run `fn` when the server closes. */
  onClose(fn: LifecycleHook): this {
    this.#onClose.push(fn);
    return this;
  }

  /** Load all registered plugins, awaiting async ones. Call before {@link Toki.listen}
   * when any plugin is async; `listen` loads sync plugins on its own. */
  async ready(): Promise<void> {
    if (this.#booted) {
      return;
    }
    await loadPluginsAsync(this);
    this.#booted = true;
  }

  /** Bind `port` and serve. Returns a handle whose `close()` stops the server. */
  listen(port: number, options: ServerOptions = {}): ListenHandle {
    this.#bootSync();
    for (const ready of this.#onReady) {
      this.#runLifecycle(ready, "onReady");
    }
    this.#compileAll();
    const methods = this.#routes.map((r) => r.method);
    const paths = this.#routes.map((r) => r.path);
    const staticEntries: StaticEntry[] = this.#staticMounts.flatMap((mount) =>
      buildStaticEntries(mount.prefix, mount.dir, mount.options),
    );
    const serverOptions: ServerOptions = {
      ...options,
      notFound: this.#compiledNotFound !== undefined,
    };
    if (options.rateLimit) {
      serverOptions.rateLimitMax = options.rateLimit.max;
      serverOptions.rateLimitWindowMs = options.rateLimit.windowMs;
    }
    this.#boundPort = native.listen(
      port,
      methods,
      paths,
      (raw) => this.#dispatch(raw),
      staticEntries,
      serverOptions,
    );
    this.#listening = true;
    return {
      close: () => {
        for (const fn of this.#onClose) {
          this.#runLifecycle(fn, "onClose");
        }
        this.#listening = false;
        native.close();
      },
    };
  }

  /**
   * Inject a request in-process for testing. Sends a real request over loopback so
   * the full native path runs, auto-binding an ephemeral port when not already
   * listening. Returns the captured response.
   */
  async inject(options: InjectOptions | string): Promise<InjectResponse> {
    if (!this.#listening) {
      this.listen(0, { host: "127.0.0.1" });
    }
    return inject(this.#boundPort, options);
  }

  /** Loads sync plugins; throws if any plugin is async (call `ready()` first). */
  #bootSync(): void {
    if (this.#booted) {
      return;
    }
    loadPluginsSync(this);
    this.#booted = true;
  }

  #compileAll(): void {
    this.#compiled = this.#routes.map((route) => this.#compile(route));
    this.#compiledNotFound =
      this.#notFoundHandler !== undefined
        ? this.#compileNotFound(this.#notFoundHandler)
        : undefined;
  }

  // resolve a route's chains by walking scope ancestry (root → leaf). order:
  // onRequest → use → group → preValidation → (validation) → preHandler → handler →
  // onResponse → onSend, each phase running outer scopes before inner ones.
  #compile(route: Route): CompiledRoute {
    const chain = ancestry(route.scope);
    const before: Middleware[] = [];
    for (const s of chain) before.push(...s.onRequest);
    for (const s of chain) before.push(...s.preParsing);
    for (const s of chain) before.push(...s.middleware);
    before.push(...route.groupMiddleware);
    for (const s of chain) before.push(...s.preValidation);
    before.push(...asArray(route.options.preValidation));
    if (route.options.schema) {
      before.push(validationStep(route.options.schema));
    }
    for (const s of chain) before.push(...s.preHandler);
    before.push(...asArray(route.options.preHandler));

    const after: ResponseHook[] = [];
    for (const s of chain) after.push(...s.onResponse);
    for (const s of chain) after.push(...s.onSend);

    const serialization: SerializationHook[] = [];
    for (const s of chain) serialization.push(...s.preSerialization);
    serialization.push(...asArray(route.options.preSerialization));

    // parsers resolve nearest-scope-first (leaf → root)
    const parsers: ContentTypeParserEntry[] = [];
    for (let i = chain.length - 1; i >= 0; i--) parsers.push(...chain[i]!.contentTypeParsers);

    const onTimeout: TimeoutHook[] = [];
    for (const s of chain) onTimeout.push(...s.onTimeout);

    const decorators = Object.assign({}, ...chain.map((s) => s.requestDecorators));
    let errorHandler: ErrorHandler | undefined;
    for (const s of chain) {
      if (s.errorHandler) errorHandler = s.errorHandler;
    }

    const compiled: CompiledRoute = {
      handler: route.handler,
      before,
      after,
      serialization,
      onTimeout,
      parsers,
      decorators,
    };
    const withError = errorHandler ? { ...compiled, errorHandler } : compiled;
    return route.options.schema?.response
      ? { ...withError, responseSchemas: route.options.schema.response }
      : withError;
  }

  // not-found handler runs the root chains, defaults to 404
  #compileNotFound(handler: Handler): CompiledRoute {
    return {
      handler,
      before: [
        ...this.onRequest,
        ...this.preParsing,
        ...this.middleware,
        ...this.preValidation,
        ...this.preHandler,
      ],
      after: [...this.onResponse, ...this.onSend],
      serialization: [...this.preSerialization],
      onTimeout: [...this.onTimeout],
      parsers: [...this.contentTypeParsers],
      decorators: this.requestDecorators,
      ...(this.errorHandler ? { errorHandler: this.errorHandler } : {}),
      defaultStatus: 404,
    };
  }

  #dispatch(raw: NativeRequest): NativeResponse | undefined {
    const route =
      raw.routeIndex === NOT_FOUND_INDEX ? this.#compiledNotFound : this.#compiled[raw.routeIndex];
    if (route === undefined) {
      return toNative(reply.empty(raw.routeIndex === NOT_FOUND_INDEX ? 404 : 500));
    }
    const req = new TokiRequest(raw, { log: this.#loggerInstance, parsers: route.parsers });
    Object.assign(req, route.decorators);
    try {
      const outcome = this.#run(req, route);
      if (isThenable(outcome)) {
        const id = raw.dispatchId;
        const timer = this.#armTimeout(id, req, route);
        void Promise.resolve(outcome)
          .then(
            (result) => {
              if (timer) clearTimeout(timer);
              this.#submit(id, req, result);
            },
            (error) => {
              if (timer) clearTimeout(timer);
              this.#submit(id, req, this.#handleError(req, error, route.errorHandler));
            },
          )
          .catch((error: unknown) => {
            // last resort: a throw inside #submit itself (e.g. native call failed)
            req.log.error("dispatch settle failed", { error: String(error) });
          });
        return undefined;
      }
      if (isStreamResponse(outcome)) {
        // engine suspends the connection only on the `undefined` we return below,
        // so drive the stream on the next microtask, not now
        const id = raw.dispatchId;
        queueMicrotask(() => this.#driveSafe(id, req, outcome));
        return undefined;
      }
      return toNative(outcome, req.stagedResponseHeaders);
    } catch (error) {
      return this.#safeToNative(this.#handleError(req, error, route.errorHandler), req);
    }
  }

  #submit(id: number, req: TokiRequest, result: HandlerResult): void {
    if (isStreamResponse(result)) {
      this.#driveSafe(id, req, result);
      return;
    }
    native.submitResponse(id, this.#safeToNative(result, req));
  }

  // #drive owns its own try/finally, but startStream can throw before it; never let
  // a stream turn into an unhandled rejection.
  #driveSafe(id: number, req: TokiRequest, stream: StreamResponse): void {
    void this.#drive(id, req, stream).catch((error: unknown) => {
      req.log.error("stream drive failed", { error: String(error) });
      try {
        native.endStream(id);
      } catch {
        // connection already gone
      }
    });
  }

  // run an onReady/onClose hook without letting a sync throw or async rejection escape
  #runLifecycle(fn: LifecycleHook, name: string): void {
    try {
      const result = fn();
      if (isThenable(result)) {
        void result.catch((error: unknown) =>
          this.#loggerInstance.error(`${name} hook failed`, { error: String(error) }),
        );
      }
    } catch (error) {
      this.#loggerInstance.error(`${name} hook failed`, { error: String(error) });
    }
  }

  // arm a timeout for an async dispatch: run onTimeout hooks and reply 408 if the
  // handler hasn't settled in time. caller clears the returned timer on settle.
  #armTimeout(
    id: number,
    req: TokiRequest,
    route: CompiledRoute,
  ): ReturnType<typeof setTimeout> | undefined {
    if (this.#requestTimeoutMs <= 0) {
      return undefined;
    }
    const timer = setTimeout(() => {
      for (const hook of route.onTimeout) {
        try {
          void hook(req);
        } catch {
          // a timeout hook must not break the timeout response
        }
      }
      // no-op if the handler already settled (its dispatch id is consumed)
      this.#submit(id, req, reply.text("Request Timeout", 408));
    }, this.#requestTimeoutMs);
    // a pending timeout must not keep the process alive
    timer.unref?.();
    return timer;
  }

  async #drive(id: number, req: TokiRequest, stream: StreamResponse): Promise<void> {
    native.startStream(id, stream.status, streamHeaderBlock(stream, req.stagedResponseHeaders));
    const encoder = new TextEncoder();
    try {
      for await (const chunk of stream.source as AsyncIterable<Uint8Array | string>) {
        const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        if (bytes.length === 0) {
          continue;
        }
        const backlog = native.writeStreamChunk(id, bytes);
        if (backlog < 0) {
          return; // connection gone; endStream (in finally) is a no-op
        }
        if (backlog > STREAM_HIGH_WATER) {
          await new Promise((resolve) => setTimeout(resolve, 1)); // let the socket drain
        }
      }
    } catch (error) {
      req.log.error("stream source failed", { error: String(error) });
    } finally {
      native.endStream(id);
    }
  }

  #safeToNative(result: HandlerResult, req: TokiRequest): NativeResponse {
    try {
      return toNative(result, req.stagedResponseHeaders);
    } catch {
      return toNative(reply.empty(500));
    }
  }

  #run(req: TokiRequest, route: CompiledRoute): HandlerResult | Promise<HandlerResult> {
    const short = runBefore(route.before, req, 0);
    if (isThenable(short)) {
      return short.then((value) => this.#afterBefore(req, route, value));
    }
    return this.#afterBefore(req, route, short);
  }

  #afterBefore(
    req: TokiRequest,
    route: CompiledRoute,
    shortCircuit: HandlerResult | undefined,
  ): HandlerResult | Promise<HandlerResult> {
    const result = shortCircuit !== undefined ? shortCircuit : route.handler(req);
    if (isThenable(result)) {
      return result.then((value) => this.#afterHandler(req, route, value));
    }
    return this.#afterHandler(req, route, result);
  }

  #afterHandler(
    req: TokiRequest,
    route: CompiledRoute,
    result: HandlerResult,
  ): HandlerResult | Promise<HandlerResult> {
    // a stream has no materialized body, so it skips serialization, materialization,
    // and response hooks; the dispatcher drives it
    if (isStreamResponse(result)) {
      return result;
    }
    // preSerialization only sees plain values bound for JSON, not a built reply or string
    if (route.serialization.length > 0 && !isTokiResponse(result) && typeof result !== "string") {
      const transformed = runSerialization(route.serialization, req, result, 0);
      if (isThenable(transformed)) {
        return transformed.then((value) =>
          this.#finishResponse(req, route, value as HandlerResult),
        );
      }
      return this.#finishResponse(req, route, transformed as HandlerResult);
    }
    return this.#finishResponse(req, route, result);
  }

  #finishResponse(
    req: TokiRequest,
    route: CompiledRoute,
    result: HandlerResult,
  ): HandlerResult | Promise<HandlerResult> {
    const res = materialize(result, route);
    if (route.after.length === 0) {
      return res;
    }
    return runAfter(route.after, req, res, 0);
  }

  #handleError(req: TokiRequest, error: unknown, errorHandler?: ErrorHandler): HandlerResult {
    req.log.error("request handler threw", { error: String(error) });
    if (errorHandler !== undefined) {
      try {
        return errorHandler(req, error);
      } catch {
        // error handler itself threw; fall through to the default
      }
    }
    return reply.text("Internal Server Error", 500);
  }
}

/** Create a new application. */
export function createApp(options?: TokiOptions): Toki {
  return new Toki(options);
}

// scope and all ancestors, ordered root → leaf
function ancestry(scope: Scope): Scope[] {
  const chain: Scope[] = [];
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    chain.unshift(s);
  }
  return chain;
}

// load a scope's plugins depth-first; throws on the first async plugin
function loadPluginsSync(scope: Scope): void {
  for (const entry of scope.plugins) {
    const result = entry.plugin(entry.scope, entry.opts);
    if (isThenable(result)) {
      throw new Error("async plugin registered — call `await app.ready()` before `listen()`");
    }
    loadPluginsSync(entry.scope);
  }
}

// load a scope's plugins depth-first, awaiting each
async function loadPluginsAsync(scope: Scope): Promise<void> {
  for (const entry of scope.plugins) {
    await entry.plugin(entry.scope, entry.opts);
    await loadPluginsAsync(entry.scope);
  }
}
