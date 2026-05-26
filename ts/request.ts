import type { Toki } from "./app";
import type { HttpRequest, Param, ParsedForm } from "./binding";
import { silentLogger, type Logger } from "./logger";
import type { Handler, ListenOptions, RouteMethod } from "./types";

// Repeated names keep the first value, matching single-value accessors like `req.params.id`.
function paramsToRecord(pairs: ReadonlyArray<Param>): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const { name, value } of pairs) {
    if (!(name in out)) {
      out[name] = value;
    }
  }
  return Object.freeze(out);
}

/** Per-request context from the dispatcher; kept off {@link HttpRequest} so the fast path is unaffected. */
export interface RequestContext {
  readonly log: Logger;
}

/**
 * An incoming request handed to a {@link Handler}. Headers and the query string use the standard
 * {@link Headers}/{@link URLSearchParams}. Constructed per request, not meant to be created directly.
 */
export class TokiRequest {
  /** The HTTP method, e.g. `"GET"`. Any verb is possible (see {@link Toki.route}). */
  readonly method: RouteMethod;

  /** The path, without the query string, e.g. `"/users/42"`. */
  readonly path: string;

  /** Params captured from the route pattern; an absent key reads as `undefined`. */
  readonly params: Readonly<Record<string, string | undefined>>;

  /** The parsed query string. */
  readonly query: URLSearchParams;

  /** The request headers. */
  readonly headers: Headers;

  /** The raw request body, or `null` when there is none. */
  readonly body: Uint8Array | null;

  /**
   * The natively parsed form, or `null` otherwise. Populated only with
   * `parseForms` enabled and a recognized form `Content-Type`; the raw bytes
   * remain on {@link TokiRequest.body} in every other case.
   */
  readonly form: ParsedForm | null;

  /** Cookies parsed from the `Cookie` header; an absent key reads as `undefined`. */
  readonly cookies: Readonly<Record<string, string | undefined>>;

  /** A unique id for this request, generated natively. Also stamped onto {@link TokiRequest.log}. */
  readonly id: string;

  /** A {@link Logger} child bound to {@link TokiRequest.id}; silent when no logger was configured. */
  readonly log: Logger;

  constructor(raw: HttpRequest, context?: RequestContext) {
    this.method = raw.method;
    this.path = raw.path;

    // Params, query, and cookies are parsed and percent-decoded natively; we only reshape them.
    this.params = paramsToRecord(raw.params);

    const query = new URLSearchParams();
    for (const { name, value } of raw.queryPairs) {
      query.append(name, value);
    }
    this.query = query;

    this.cookies = paramsToRecord(raw.cookies);

    const headers = new Headers();
    for (const header of raw.headers) {
      headers.append(header.name, header.value);
    }
    this.headers = headers;

    this.body = raw.body ?? null;
    this.form = raw.form ?? null;

    this.id = raw.requestId;
    this.log = context?.log ?? silentLogger;
  }

  // Lets a pre-handler step stage response headers before the response object exists; the
  // dispatcher merges these in, with the response's own headers winning except appendable fields.
  readonly #responseHeaders = new Headers();

  /** Stage a response header for the eventual response, replacing any previously staged value. */
  setResponseHeader(name: string, value: string): this {
    this.#responseHeaders.set(name, value);
    return this;
  }

  /** Stage a response header, appending rather than replacing (e.g. `Vary`, `Set-Cookie`). */
  appendResponseHeader(name: string, value: string): this {
    this.#responseHeaders.append(name, value);
    return this;
  }

  /** @internal Read by the dispatcher; not intended for handler use. */
  get stagedResponseHeaders(): Headers {
    return this.#responseHeaders;
  }

  /** Decode the body as UTF-8 text, or `""` when there is none. */
  text(): string {
    return this.body ? new TextDecoder().decode(this.body) : "";
  }

  /** Parse the body as JSON. `T` is an unchecked assertion; throws on malformed input. */
  json<T = unknown>(): T {
    return JSON.parse(this.text()) as T;
  }
}
