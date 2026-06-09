import { inject, type InjectOptions, type InjectResponse } from "../http/inject.ts";
import { resolveLogger } from "./logger.ts";
import { Scope, type Route } from "./scope.ts";
import {
  native,
  type NativeRequest,
  type NativeResponse,
  type ServerOptions,
  type StaticEntry,
} from "../native/native.ts";
import {
  isThenable,
  materialize,
  runAfter,
  runBefore,
  runSerialization,
  validationStep,
} from "./pipeline.ts";
import { TokiRequest } from "../http/request.ts";
import { isStreamResponse, isTokiResponse, reply, toNative } from "../http/response.ts";
import type { JSONSchema } from "../http/schema.ts";
import { TokiWebSocket, WS_EVENT, type WebSocketHandler } from "../websocket/websocket.ts";
import { buildStaticEntries, type StaticOptions } from "../http/static.ts";
import type {
  ContentTypeParserEntry,
  ErrorHandler,
  Handler,
  HandlerResult,
  LifecycleHook,
  ListenHandle,
  Logger,
  Middleware,
  ResponseHook,
  SerializationHook,
  StreamResponse,
  TimeoutHook,
  TokiOptions,
} from "./types.ts";

// TLS cert/key accepted as PEM text or raw bytes; the native side reads a Buffer.
function toPem(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
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
  // undefined when no scope decorated the request, so the hot path skips the merge
  readonly decorators: Record<string, unknown> | undefined;
  // nearest-scope handler; undefined falls back to default
  readonly errorHandler?: ErrorHandler;
  readonly responseSchemas?: Record<number, JSONSchema>;
  // status for a non-`reply` result: 404 for not-found route, else 200
  readonly defaultStatus?: number;
}

// shared by every streaming response; encode() keeps no state between calls
const streamEncoder = new TextEncoder();
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
 * The application. Register routes (optionally with a validation schema and
 * route-scoped hooks), global hooks, middleware, and plugins, then
 * {@link Toki.listen}. The pipeline runs synchronously until a step returns a
 * `Promise`; the common sync request never leaves the fast path.
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
  // handler per native route index (undefined for non-ws routes), and live sockets by id
  #wsHandlers: Array<WebSocketHandler | undefined> = [];
  readonly #wsSockets = new Map<number, TokiWebSocket>();
  // caps inflation of a compressed ws message (set from listen options)
  #wsMaxMessage = 16 * 1024 * 1024;
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
    if (options.tls) {
      serverOptions.tlsCert = toPem(options.tls.cert);
      serverOptions.tlsKey = toPem(options.tls.key);
    }
    const wsRouteIndices: number[] = [];
    const wsProtocols: string[] = [];
    this.#routes.forEach((route, index) => {
      if (route.webSocket) {
        wsRouteIndices.push(index);
        wsProtocols.push((route.webSocket.options.protocols ?? []).join(","));
      }
    });
    this.#wsMaxMessage = options.maxWsMessageBytes ?? this.#wsMaxMessage;
    this.#boundPort = native.listen(
      port,
      methods,
      paths,
      (raw) => this.#dispatch(raw),
      staticEntries,
      serverOptions,
      (id, event, a, b, c) => this.#wsDispatch(id, event, a, b, c),
      wsRouteIndices,
      wsProtocols,
    );
    this.#listening = true;
    return {
      port: this.#boundPort,
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
    this.#wsHandlers = this.#routes.map((route) => route.webSocket?.handler);
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

    const merged = Object.assign({}, ...chain.map((s) => s.requestDecorators));
    const decorators = Object.keys(merged).length > 0 ? merged : undefined;
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
      decorators:
        Object.keys(this.requestDecorators).length > 0 ? this.requestDecorators : undefined,
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
    if (route.decorators !== undefined) Object.assign(req, route.decorators);
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
        // engine only suspends the connection on the `undefined` returned below.
        // drive the stream on the next microtask, not now.
        const id = raw.dispatchId;
        queueMicrotask(() => this.#driveSafe(id, req, outcome));
        return undefined;
      }
      return toNative(outcome, req.stagedResponseHeaders);
    } catch (error) {
      return this.#safeToNative(this.#handleError(req, error, route.errorHandler), req);
    }
  }

  // routes native WebSocket events to the live socket; one bad listener is logged,
  // never allowed to escape into the native dispatch call
  #wsDispatch(wsId: number, event: number, a: unknown, b: unknown, c: unknown): void {
    try {
      switch (event) {
        case WS_EVENT.open: {
          const raw = a as NativeRequest;
          const handler = this.#wsHandlers[raw.routeIndex];
          if (handler === undefined) return;
          const socket = new TokiWebSocket(wsId, (b as string) ?? "", c === 1, this.#wsMaxMessage);
          this.#wsSockets.set(wsId, socket);
          handler(socket, new TokiRequest(raw, { log: this.#loggerInstance }));
          return;
        }
        case WS_EVENT.message: {
          const flags = a as number;
          this.#wsSockets.get(wsId)?._message(b as Buffer, (flags & 1) !== 0, (flags & 2) !== 0);
          return;
        }
        case WS_EVENT.close: {
          const socket = this.#wsSockets.get(wsId);
          this.#wsSockets.delete(wsId);
          socket?._close(a as number, (b as string) ?? "");
          return;
        }
        case WS_EVENT.ping:
          this.#wsSockets.get(wsId)?._ping(b as Buffer);
          return;
        case WS_EVENT.pong:
          this.#wsSockets.get(wsId)?._pong(b as Buffer);
          return;
        case WS_EVENT.drain:
          this.#wsSockets.get(wsId)?._drain();
          return;
      }
    } catch (error) {
      this.#loggerInstance.error("websocket handler threw", { error: String(error) });
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
    try {
      for await (const chunk of stream.source as AsyncIterable<Uint8Array | string>) {
        const bytes = typeof chunk === "string" ? streamEncoder.encode(chunk) : chunk;
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
