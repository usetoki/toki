import type { Toki } from "./app";
import { createHookStore, type HookSignatures, type HookStore, type Middleware } from "./hooks";
import type { Handler, RouteMethod } from "./types";

/** The registration entry point a {@link RouteGroup} funnels routes into; implemented by {@link Toki}. */
export interface RouteSink {
  /** Register one dynamic route with its fully-resolved path and scope chain (root first). */
  add(method: RouteMethod, path: string, handler: Handler, scopes: readonly HookStore[]): void;
}

/** Anything that can register routes under a prefix with a scope chain. */
export type RouteRegistrar = RouteSink;

/** Join a parent prefix with a child path into one normalized, single-slash-separated path. */
export function joinPaths(prefix: string, path: string): string {
  const left = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const right = path.startsWith("/") ? path : `/${path}`;
  const joined = `${left}${right}`;
  if (joined.length === 0) {
    return "/";
  }
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * A child registrar that prepends a prefix to its routes and owns a {@link HookStore} scoped to
 * them. Obtain one via `app.group(prefix, (group) => { ... })`; routes funnel into the owning app's
 * shared {@link RouteSink}, so there is no separate match pass per group. Groups may nest.
 */
export class RouteGroup {
  readonly #sink: RouteSink;
  readonly #prefix: string;
  readonly #scopes: readonly HookStore[];
  readonly #store: HookStore;

  constructor(sink: RouteSink, prefix: string, parentScopes: readonly HookStore[]) {
    this.#sink = sink;
    this.#prefix = prefix;
    this.#store = createHookStore();
    this.#scopes = [...parentScopes, this.#store];
  }

  /** Register a `GET` handler under this group's prefix. */
  get(path: string, handler: Handler): this {
    return this.#register("GET", path, handler);
  }

  /** Register a `POST` handler under this group's prefix. */
  post(path: string, handler: Handler): this {
    return this.#register("POST", path, handler);
  }

  /** Register a `PUT` handler under this group's prefix. */
  put(path: string, handler: Handler): this {
    return this.#register("PUT", path, handler);
  }

  /** Register a `PATCH` handler under this group's prefix. */
  patch(path: string, handler: Handler): this {
    return this.#register("PATCH", path, handler);
  }

  /** Register a `DELETE` handler under this group's prefix. */
  delete(path: string, handler: Handler): this {
    return this.#register("DELETE", path, handler);
  }

  /** Register a `HEAD` handler under this group's prefix. */
  head(path: string, handler: Handler): this {
    return this.#register("HEAD", path, handler);
  }

  /** Register an `OPTIONS` handler under this group's prefix. */
  options(path: string, handler: Handler): this {
    return this.#register("OPTIONS", path, handler);
  }

  /** Register a handler for an arbitrary method under this group's prefix. */
  route(method: RouteMethod, path: string, handler: Handler): this {
    return this.#register(method, path, handler);
  }

  /** Register a lifecycle hook scoped to this group (runs after the root's hooks of that name). */
  addHook<K extends keyof HookSignatures>(name: K, fn: HookSignatures[K]): this {
    if (name === "onResponse") {
      this.#store.onResponse.push(fn as HookSignatures["onResponse"]);
    } else if (name === "onRequest") {
      this.#store.onRequest.push(fn as HookSignatures["onRequest"]);
    } else {
      this.#store.preHandler.push(fn as HookSignatures["preHandler"]);
    }
    return this;
  }

  /** Register middleware scoped to this group (runs after the root's middleware). */
  use(fn: Middleware): this {
    this.#store.middleware.push(fn);
    return this;
  }

  /** Create a nested group whose prefix extends this one's, inheriting its hooks and middleware. */
  group(prefix: string, builder: (group: RouteGroup) => void): this {
    const child = new RouteGroup(this.#sink, joinPaths(this.#prefix, prefix), this.#scopes);
    builder(child);
    return this;
  }

  #register(method: RouteMethod, path: string, handler: Handler): this {
    this.#sink.add(method, joinPaths(this.#prefix, path), handler, this.#scopes);
    return this;
  }
}
