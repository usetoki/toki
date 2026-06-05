import { type CookieOptions, parseCookies, serializeCookie } from "./cookies.js";
import { parseForm, type ParsedForm } from "./forms.js";
import { silentLogger } from "../core/logger.js";
import type { NativeRequest } from "../native/native.js";
import type { ContentTypeParserEntry, Logger, RouteMethod } from "../core/types.js";

let sequence = 0;

const NO_PARSERS: readonly ContentTypeParserEntry[] = [];
// one decoder for every body read; TextDecoder is stateless across decode() calls
const decoder = new TextDecoder();

/** Per-request context the dispatcher supplies; kept off the hot fields. */
interface RequestContext {
  readonly log: Logger;
  /** Content-type parsers in effect for this route (nearest scope first). */
  readonly parsers?: readonly ContentTypeParserEntry[];
}

/**
 * An incoming request handed to a handler. Query/headers parsed lazily.
 * Backed by an engine-owned buffer — valid only during the handler call;
 * read the body before any `await`.
 */
export class TokiRequest {
  /** The HTTP method, e.g. `"GET"`. */
  readonly method: RouteMethod;

  /** The path, without the query string, e.g. `"/users/42"`. */
  readonly path: string;

  /** The raw request body, or `null` when there is none. */
  readonly body: Uint8Array | null;

  /** The peer IP address. */
  readonly ip: string;

  /** A {@link Logger} for this request; silent unless a logger was configured. */
  readonly log: Logger;

  // backs the lazy accessors; reshaped only on first read
  readonly #raw: NativeRequest;
  readonly #parsers: readonly ContentTypeParserEntry[];

  constructor(raw: NativeRequest, context?: RequestContext) {
    this.#raw = raw;
    this.method = raw.method as RouteMethod;
    this.path = raw.path;
    this.body = raw.body;
    this.ip = raw.ip;
    this.log = context?.log ?? silentLogger;
    this.#parsers = context?.parsers ?? NO_PARSERS;
  }

  /** The request host (from the `Host` header), without the port. */
  get hostname(): string {
    const host = this.#header("host") ?? "";
    const colon = host.lastIndexOf(":");
    return colon === -1 ? host : host.slice(0, colon);
  }

  /** `"https"` when forwarded as such by a proxy, else `"http"`. */
  get protocol(): string {
    return this.#header("x-forwarded-proto") ?? "http";
  }

  // Look up one header by lowercased name without building the full Headers object.
  // The common getters (host, cookie, content-type) read a single header, so this
  // keeps them off the Headers-construction path; `req.headers` stays a real Headers.
  #header(name: string): string | null {
    const raw = this.#raw.rawHeaders;
    let i = 0;
    while (i < raw.length) {
      const nl = raw.indexOf("\r\n", i);
      const end = nl === -1 ? raw.length : nl;
      const colon = raw.indexOf(":", i);
      if (colon !== -1 && colon < end && raw.slice(i, colon).toLowerCase() === name) {
        return raw.slice(colon + 1, end).trimStart();
      }
      if (nl === -1) break;
      i = nl + 2;
    }
    return null;
  }

  #id?: string;
  #params?: Readonly<Record<string, string | undefined>>;
  #query?: URLSearchParams;
  #headers?: Headers;
  #cookies?: Readonly<Record<string, string | undefined>>;

  /** A short id unique within this process run; generated on first read. */
  get id(): string {
    return (this.#id ??= (sequence++).toString(36));
  }

  /** Params captured from the route pattern (`:id`, `*`); an absent key reads as `undefined`. */
  get params(): Readonly<Record<string, string | undefined>> {
    return (this.#params ??= Object.freeze(this.#raw.params ?? {}));
  }

  /** The parsed query string. */
  get query(): URLSearchParams {
    return (this.#query ??= new URLSearchParams(this.#raw.query));
  }

  /** The request headers. */
  get headers(): Headers {
    if (this.#headers === undefined) {
      const headers = new Headers();
      for (const line of this.#raw.rawHeaders.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) {
          continue;
        }
        headers.append(line.slice(0, colon), line.slice(colon + 1).trimStart());
      }
      this.#headers = headers;
    }
    return this.#headers;
  }

  // pre-handler can stage headers before the response exists; dispatcher merges them,
  // response's own headers win on conflict
  #staged?: Array<[string, string]>;

  /** Stage a response header, replacing any previously staged value for `name`. */
  setResponseHeader(name: string, value: string): this {
    const staged = (this.#staged ??= []);
    const lower = name.toLowerCase();
    for (let i = 0; i < staged.length; i++) {
      if (staged[i]![0].toLowerCase() === lower) {
        staged[i] = [name, value];
        return this;
      }
    }
    staged.push([name, value]);
    return this;
  }

  /** Stage a response header, appending rather than replacing (e.g. `Set-Cookie`). */
  appendResponseHeader(name: string, value: string): this {
    (this.#staged ??= []).push([name, value]);
    return this;
  }

  /** Cookies parsed from the `Cookie` header; an absent key reads as `undefined`. */
  get cookies(): Readonly<Record<string, string | undefined>> {
    if (this.#cookies === undefined) {
      const header = this.#header("cookie");
      this.#cookies = header ? parseCookies(header) : Object.freeze({});
    }
    return this.#cookies;
  }

  /** Set a cookie on the response (staged as a `Set-Cookie` header). */
  setCookie(name: string, value: string, options?: CookieOptions): this {
    return this.appendResponseHeader("Set-Cookie", serializeCookie(name, value, options));
  }

  /** Clear a cookie by setting it expired. */
  clearCookie(name: string, options?: CookieOptions): this {
    return this.setCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) });
  }

  /** @internal Read by the dispatcher; not intended for handler use. */
  get stagedResponseHeaders(): ReadonlyArray<readonly [string, string]> {
    return this.#staged ?? [];
  }

  /** Decode the body as UTF-8 text, or `""` when there is none. */
  text(): string {
    return this.body ? decoder.decode(this.body) : "";
  }

  /** Parse the body as JSON. `T` is an unchecked assertion; throws on malformed input. */
  json<T = unknown>(): T {
    return JSON.parse(this.text()) as T;
  }

  #form?: ParsedForm | null;

  /** Body parsed as a form (urlencoded/multipart); null for any other content type. */
  get form(): ParsedForm | null {
    if (this.#form === undefined) {
      this.#form = this.body ? parseForm(this.#header("content-type") ?? "", this.body) : null;
    }
    return this.#form;
  }

  #parsedDone = false;
  #parsedValue: unknown;

  /**
   * Body parsed by the matching content-type parser, falling back to built-ins
   * (JSON/text/forms) else raw bytes. Cached; `undefined` when no body. `T` unchecked.
   */
  async parseBody<T = unknown>(): Promise<T> {
    if (!this.#parsedDone) {
      this.#parsedValue = await this.#runParse();
      this.#parsedDone = true;
    }
    return this.#parsedValue as T;
  }

  #runParse(): unknown | Promise<unknown> {
    const body = this.body;
    if (!body) {
      return undefined;
    }
    const contentType = (this.#header("content-type") ?? "").toLowerCase();
    for (const entry of this.#parsers) {
      if (entry.test(contentType)) {
        return entry.parser(this, body);
      }
    }
    if (contentType.startsWith("application/json") || contentType.includes("+json")) {
      return this.json();
    }
    if (contentType.startsWith("text/")) {
      return this.text();
    }
    if (
      contentType.startsWith("application/x-www-form-urlencoded") ||
      contentType.startsWith("multipart/form-data")
    ) {
      return this.form;
    }
    return body;
  }
}
