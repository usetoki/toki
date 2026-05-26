import type { Middleware } from "./hooks";
import type { TokiRequest } from "./request";
import { reply, type TokiResponse } from "./response";

/** A single origin, a list of origins, a boolean toggle, or a predicate over the origin. */
export type CorsOrigin = string | readonly string[] | boolean | ((origin: string) => boolean);

/** Options for {@link cors}. */
export interface CorsOptions {
  /** Allowed origin(s); `"*"`/`true` allows any, `false` disables CORS. Defaults to `"*"`. */
  origin?: CorsOrigin;
  /** Methods advertised in `Access-Control-Allow-Methods`. Defaults to the common verbs. */
  methods?: readonly string[];
  /** Allowed headers; when omitted, preflight reflects `Access-Control-Request-Headers`. */
  allowedHeaders?: readonly string[];
  /** Headers exposed via `Access-Control-Expose-Headers`. */
  exposedHeaders?: readonly string[];
  /** Sets `Access-Control-Allow-Credentials: true` when `true`. */
  credentials?: boolean;
  /** `Access-Control-Max-Age`, in seconds, for caching preflight results. */
  maxAge?: number;
  /** Status returned for a handled preflight. Defaults to `204`. */
  optionsSuccessStatus?: number;
}

const DEFAULT_CORS_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"] as const;

// Returns null when the origin is not allowed, meaning no CORS header should be set.
function resolveAllowedOrigin(option: CorsOrigin, requestOrigin: string | null): string | null {
  if (option === false) {
    return null;
  }
  if (option === true || option === "*") {
    return "*";
  }
  if (typeof option === "string") {
    return option;
  }
  if (requestOrigin === null) {
    return null;
  }
  if (typeof option === "function") {
    return option(requestOrigin) ? requestOrigin : null;
  }
  return option.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * CORS {@link Middleware}: stages `Access-Control-*` headers on every request and answers
 * preflight `OPTIONS` immediately with an empty success response.
 *
 * ```ts
 * app.use(cors({ origin: ["https://app.example.com"], credentials: true }));
 * ```
 */
export function cors(options: CorsOptions = {}): Middleware {
  const originOption: CorsOrigin = options.origin ?? "*";
  const methods = (options.methods ?? DEFAULT_CORS_METHODS).join(", ");
  const allowedHeaders = options.allowedHeaders?.join(", ");
  const exposedHeaders = options.exposedHeaders?.join(", ");
  const optionsSuccessStatus = options.optionsSuccessStatus ?? 204;

  return (request: TokiRequest): void | TokiResponse => {
    const requestOrigin = request.headers.get("origin");
    const allowOrigin = resolveAllowedOrigin(originOption, requestOrigin);

    if (allowOrigin !== null) {
      request.setResponseHeader("access-control-allow-origin", allowOrigin);
      // A dynamic origin must vary on Origin so shared caches don't cross-serve responses.
      if (allowOrigin !== "*") {
        request.appendResponseHeader("vary", "Origin");
      }
    }
    if (options.credentials) {
      request.setResponseHeader("access-control-allow-credentials", "true");
    }
    if (exposedHeaders) {
      request.setResponseHeader("access-control-expose-headers", exposedHeaders);
    }

    const isPreflight =
      request.method === "OPTIONS" && request.headers.get("access-control-request-method") !== null;
    if (!isPreflight) {
      return undefined;
    }

    const headers = new Headers();
    if (allowOrigin !== null) {
      headers.set("access-control-allow-origin", allowOrigin);
      if (allowOrigin !== "*") {
        headers.append("vary", "Origin");
      }
    }
    if (options.credentials) {
      headers.set("access-control-allow-credentials", "true");
    }
    headers.set("access-control-allow-methods", methods);
    const reqHeaders = request.headers.get("access-control-request-headers");
    if (allowedHeaders) {
      headers.set("access-control-allow-headers", allowedHeaders);
    } else if (reqHeaders) {
      headers.set("access-control-allow-headers", reqHeaders);
      headers.append("vary", "Access-Control-Request-Headers");
    }
    if (options.maxAge !== undefined) {
      headers.set("access-control-max-age", String(options.maxAge));
    }
    headers.set("content-length", "0");
    return reply.empty(optionsSuccessStatus, { headers });
  };
}

/** Well-known `Referrer-Policy` values accepted by {@link securityHeaders}. */
export type ReferrerPolicy =
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

/** Options for {@link securityHeaders}. */
export interface SecurityHeadersOptions {
  /** `X-Content-Type-Options`. Set `false` to omit. Defaults to `"nosniff"`. */
  contentTypeOptions?: "nosniff" | false;
  /** `X-Frame-Options`. Set `false` to omit. Defaults to `"SAMEORIGIN"`. */
  frameOptions?: "DENY" | "SAMEORIGIN" | false;
  /** `Referrer-Policy`. Set `false` to omit. Defaults to `"no-referrer"`. */
  referrerPolicy?: ReferrerPolicy | false;
  /**
   * `Strict-Transport-Security`. Provide max-age (seconds) and flags, or `false`
   * to omit. Omitted by default (only meaningful over HTTPS).
   */
  hsts?: { maxAge: number; includeSubDomains?: boolean; preload?: boolean } | false;
  /** `Content-Security-Policy`. Provide the policy string, or omit to skip. */
  contentSecurityPolicy?: string;
  /** `X-DNS-Prefetch-Control`. Defaults to `"off"`. Set `false` to omit. */
  dnsPrefetchControl?: "on" | "off" | false;
}

// Precomputed once so the returned middleware only stages already-resolved values per request.
function buildSecurityHeaderList(
  options: SecurityHeadersOptions,
): ReadonlyArray<readonly [string, string]> {
  const list: Array<readonly [string, string]> = [];

  const contentTypeOptions = options.contentTypeOptions ?? "nosniff";
  if (contentTypeOptions !== false) {
    list.push(["x-content-type-options", contentTypeOptions]);
  }

  const frameOptions = options.frameOptions ?? "SAMEORIGIN";
  if (frameOptions !== false) {
    list.push(["x-frame-options", frameOptions]);
  }

  const referrerPolicy = options.referrerPolicy ?? "no-referrer";
  if (referrerPolicy !== false) {
    list.push(["referrer-policy", referrerPolicy]);
  }

  const dnsPrefetchControl = options.dnsPrefetchControl ?? "off";
  if (dnsPrefetchControl !== false) {
    list.push(["x-dns-prefetch-control", dnsPrefetchControl]);
  }

  if (options.hsts) {
    let value = `max-age=${options.hsts.maxAge}`;
    if (options.hsts.includeSubDomains) {
      value += "; includeSubDomains";
    }
    if (options.hsts.preload) {
      value += "; preload";
    }
    list.push(["strict-transport-security", value]);
  }

  if (options.contentSecurityPolicy !== undefined) {
    list.push(["content-security-policy", options.contentSecurityPolicy]);
  }

  return list;
}

/**
 * Security-headers {@link Middleware} with sensible defaults (`nosniff`, `SAMEORIGIN`,
 * `Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off`); optionally adds HSTS and a CSP.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  const headerList = buildSecurityHeaderList(options);
  return (request: TokiRequest): void => {
    for (const [name, value] of headerList) {
      request.setResponseHeader(name, value);
    }
  };
}
