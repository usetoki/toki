import type { Toki } from "./app";
import type { NativeRoute } from "./binding";
import type { RouteMethod } from "./types";

/** Status, content type, and extra headers for a native route. */
export interface NativeResponseOptions {
  /** The HTTP status code. Defaults to `200`. */
  status?: number;
  /** The `Content-Type` header. Defaults per helper. */
  contentType?: string;
  /**
   * Extra headers baked into the pre-rendered bytes at registration time (zero per-request cost).
   * Do not set `Content-Type` (use `contentType`) or `Content-Length`.
   */
  headers?: Record<string, string>;
}

/**
 * Registers routes answered entirely in Rust, never crossing into JavaScript — for hot paths whose
 * response is fixed at startup. Bodies are serialized once. Obtain one via {@link Toki.native}.
 */
export class NativeRegistrar {
  readonly #routes: NativeRoute[];

  constructor(routes: NativeRoute[]) {
    this.#routes = routes;
  }

  /** A `GET` route serving a fixed `text/plain; charset=utf-8` body. */
  text(path: string, body: string, options: NativeResponseOptions = {}): this {
    return this.add("GET", path, body, options, "text/plain; charset=utf-8");
  }

  /** A `GET` route serving a fixed `text/html; charset=utf-8` body. */
  html(path: string, body: string, options: NativeResponseOptions = {}): this {
    return this.add("GET", path, body, options, "text/html; charset=utf-8");
  }

  /** A `GET` route serving a fixed JSON body, serialized once at registration. */
  json<T>(path: string, data: T, options: NativeResponseOptions = {}): this {
    return this.add("GET", path, JSON.stringify(data), options, "application/json; charset=utf-8");
  }

  /** A native route for an arbitrary method (defaults to `application/octet-stream`). */
  route(
    method: RouteMethod,
    path: string,
    body: string | Uint8Array,
    options: NativeResponseOptions = {},
  ): this {
    return this.add(method, path, body, options, "application/octet-stream");
  }

  private add(
    method: RouteMethod,
    path: string,
    body: string | Uint8Array,
    options: NativeResponseOptions,
    defaultContentType: string,
  ): this {
    const route: NativeRoute = {
      method,
      path,
      status: options.status ?? 200,
      contentType: options.contentType ?? defaultContentType,
      body: typeof body === "string" ? body : Buffer.from(body),
    };
    if (options.headers) {
      route.headers = Object.entries(options.headers).map(([name, value]) => ({ name, value }));
    }
    this.#routes.push(route);
    return this;
  }
}
