import type { HttpHeader, HttpResponse } from "./binding";
import { setCookie, type CookieOptions } from "./cookies";

/** The response a handler returns; lowered to the native {@link HttpResponse} by {@link toNative}. */
export interface TokiResponse {
  status: number;
  headers: Headers;
  /** A string, raw bytes, or `null` for an empty body. */
  body: string | Uint8Array | null;
}

/** Whatever the global {@link Headers} constructor accepts. */
export type HeadersInput = ConstructorParameters<typeof Headers>[0];

/** Status and headers shared by the {@link reply} helpers. */
export interface ResponseOptions {
  /** The HTTP status code. Defaults vary per helper. */
  status?: number;
  /** Initial headers. A `content-type` is added by helpers if absent. */
  headers?: HeadersInput;
}

function withDefaultContentType(options: ResponseOptions, contentType: string): Headers {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", contentType);
  }
  return headers;
}

/** Constructors for the common response shapes. */
export const reply = {
  /** A `text/plain; charset=utf-8` response (status `200`). */
  text(body: string, options: ResponseOptions = {}): TokiResponse {
    return {
      status: options.status ?? 200,
      headers: withDefaultContentType(options, "text/plain; charset=utf-8"),
      body,
    };
  },

  /** A `text/html; charset=utf-8` response (status `200`). */
  html(body: string, options: ResponseOptions = {}): TokiResponse {
    return {
      status: options.status ?? 200,
      headers: withDefaultContentType(options, "text/html; charset=utf-8"),
      body,
    };
  },

  /** A JSON response (status `200`); `data` is serialized with `JSON.stringify`. */
  json<T>(data: T, options: ResponseOptions = {}): TokiResponse {
    return {
      status: options.status ?? 200,
      headers: withDefaultContentType(options, "application/json; charset=utf-8"),
      body: JSON.stringify(data),
    };
  },

  /** A body-less response, e.g. `204 No Content`. No `content-type` is added. */
  empty(status = 204, options: Pick<ResponseOptions, "headers"> = {}): TokiResponse {
    return {
      status,
      headers: new Headers(options.headers),
      body: null,
    };
  },

  /** A redirect to `location` via a `Location` header (status `302`). */
  redirect(location: string, status = 302): TokiResponse {
    const headers = new Headers();
    headers.set("location", location);
    return { status, headers, body: null };
  },

  /**
   * Append a `Set-Cookie` header to a response, returning it so it can chain onto another helper:
   *
   * ```ts
   * return reply.cookie(reply.json({ ok: true }), "session", token, { httpOnly: true });
   * ```
   */
  cookie(
    response: TokiResponse,
    name: string,
    value: string,
    options: CookieOptions = {},
  ): TokiResponse {
    return setCookie(response, name, value, options);
  },
};

/** Lower a {@link TokiResponse} into the native {@link HttpResponse} shape. */
export function toNative(response: TokiResponse): HttpResponse {
  // Flatten to an ordered list so repeated fields (e.g. Set-Cookie) survive.
  const headers: HttpHeader[] = [];
  response.headers.forEach((value, name) => {
    headers.push({ name, value });
  });

  const native: HttpResponse = { status: response.status, headers };
  if (typeof response.body === "string") {
    native.body = response.body;
  } else if (response.body) {
    native.body = Buffer.from(response.body);
  }
  return native;
}
