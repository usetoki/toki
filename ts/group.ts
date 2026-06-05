import type { Handler, Middleware, RouteMethod } from "./types.js";

export function joinPaths(prefix: string, path: string): string {
  const left = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}` || "/";
}

type RegisterRoute = (
  method: RouteMethod,
  path: string,
  handler: Handler,
  middleware: Middleware[],
) => void;

/** Prefixed route group; its middleware runs after the app's. */
export class RouteGroup {
  readonly #prefix: string;
  readonly #register: RegisterRoute;
  // shared by ref with every registered route, so `use` after a route still
  // applies (resolves at listen)
  readonly #middleware: Middleware[] = [];

  constructor(prefix: string, register: RegisterRoute) {
    this.#prefix = prefix;
    this.#register = register;
  }

  /** Add middleware scoped to this group. */
  use(middleware: Middleware): this {
    this.#middleware.push(middleware);
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.#add("GET", path, handler);
  }
  post(path: string, handler: Handler): this {
    return this.#add("POST", path, handler);
  }
  put(path: string, handler: Handler): this {
    return this.#add("PUT", path, handler);
  }
  patch(path: string, handler: Handler): this {
    return this.#add("PATCH", path, handler);
  }
  delete(path: string, handler: Handler): this {
    return this.#add("DELETE", path, handler);
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

  #add(method: RouteMethod, path: string, handler: Handler): this {
    this.#register(method, joinPaths(this.#prefix, path), handler, this.#middleware);
    return this;
  }
}
