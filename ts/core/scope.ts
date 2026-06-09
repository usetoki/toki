import { joinPaths, RouteGroup } from "../http/group.ts";
import { reply } from "../http/response.ts";
import type { StaticOptions } from "../http/static.ts";
import { corsHeaders, corsPreflight, type CorsOptions } from "../security/middleware.ts";
import type { WebSocketHandler, WebSocketOptions } from "../websocket/websocket.ts";
import type { Toki } from "./app.ts";
import { contentTypeMatcher } from "./pipeline.ts";
import type {
  BodyParser,
  ContentTypeParserEntry,
  ErrorHandler,
  Handler,
  HookName,
  Logger,
  Middleware,
  PluginOptions,
  ResponseHook,
  RouteMethod,
  RouteOptions,
  SerializationHook,
  TimeoutHook,
} from "./types.ts";

export interface Route {
  readonly method: RouteMethod;
  readonly path: string;
  readonly handler: Handler;
  readonly options: RouteOptions;
  // by reference; spliced into the before-chain at listen
  readonly groupMiddleware: readonly Middleware[];
  // scope ancestry supplies the hook chains
  readonly scope: Scope;
  // set for routes registered via app.ws; an upgrade is handled natively, a plain
  // GET falls through to the handler (a 426)
  readonly webSocket?: { readonly handler: WebSocketHandler; readonly options: WebSocketOptions };
}

export interface PluginEntry {
  readonly plugin: TokiPlugin;
  readonly opts: PluginOptions;
  readonly scope: Scope;
}

/** The registration surface a plugin receives (the application or a child scope). */
export type TokiInstance = Scope;

/** Registers routes/hooks/decorators on the encapsulated `instance`. */
export type TokiPlugin = (instance: TokiInstance, opts: PluginOptions) => void | Promise<void>;

const NO_MIDDLEWARE: readonly Middleware[] = [];
// a plain GET to a ws route (no Upgrade header) gets this; native handles real upgrades
const wsUpgradeRequired: Handler = () => reply.text("Upgrade Required", 426);

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

  readonly parent: Scope | undefined;
  readonly prefix: string;

  constructor(parent: Scope | undefined, prefix: string) {
    this.parent = parent;
    this.prefix = prefix;
  }

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

  /**
   * Register a WebSocket endpoint. The handler runs once per accepted connection
   * with the live `TokiWebSocket` and the upgrade `TokiRequest`; attach
   * `message` / `close` / `ping` / `pong` / `drain` listeners on it. A plain GET
   * to the same path (no `Upgrade` header) gets a `426 Upgrade Required`.
   */
  ws(path: string, handler: WebSocketHandler): this;
  ws(path: string, options: WebSocketOptions, handler: WebSocketHandler): this;
  ws(path: string, a: WebSocketOptions | WebSocketHandler, b?: WebSocketHandler): this {
    const [options, handler] = typeof a === "function" ? [{}, a] : [a, b as WebSocketHandler];
    this.root._pushRoute({
      method: "GET",
      path: joinPaths(this.prefix, path),
      handler: wsUpgradeRequired,
      options: {},
      groupMiddleware: NO_MIDDLEWARE,
      scope: this,
      webSocket: { handler, options },
    });
    return this;
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
