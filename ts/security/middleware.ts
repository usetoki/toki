import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";
import { rawResponse, reply } from "../http/response.ts";
import type { Handler, Middleware, ResponseHook } from "../core/types.ts";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

// text + text-like only; compressing already-compressed bytes wastes cpu
function isCompressible(contentType: string): boolean {
  return /^text\/|^application\/(json|javascript|xml|wasm|.*\+json|.*\+xml)|^image\/svg/.test(
    contentType,
  );
}

// coding allowed when its token (or `*`) is present with q != 0 — mirrors the
// native static negotiator so dynamic responses honor `Accept-Encoding: br;q=0`.
function acceptsEncoding(accept: string, coding: string): boolean {
  for (const part of accept.split(",")) {
    const segment = part.trim();
    const semi = segment.indexOf(";");
    const name = (semi === -1 ? segment : segment.slice(0, semi)).trim().toLowerCase();
    if (name !== coding && name !== "*") {
      continue;
    }
    if (semi !== -1) {
      const q = /q=([\d.]+)/.exec(segment.slice(semi + 1));
      if (q !== null && Number(q[1]) === 0) {
        continue;
      }
    }
    return true;
  }
  return false;
}

const DEFAULT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export interface CorsOptions {
  /** `"*"`, a fixed origin, a list, or a predicate. Default `"*"`. */
  origin?: string | string[] | ((origin: string) => boolean);
  methods?: string[];
  /** preflight allow-headers; defaults to reflecting the request's */
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

// reflecting an arbitrary caller's origin while allowing credentials lets any site
// read authenticated responses. require an explicit allowlist for credentialed CORS.
function assertOriginConfig(options: CorsOptions): void {
  if (options.credentials && (options.origin ?? "*") === "*") {
    throw new Error(
      "cors: origin '*' cannot be combined with credentials — list the allowed origins explicitly",
    );
  }
}

// returns the ACAO value, or null to omit the header entirely
function resolveOrigin(requestOrigin: string | null, options: CorsOptions): string | null {
  const allowed = options.origin ?? "*";
  if (allowed === "*") {
    // credentials + "*" is rejected up front in assertOriginConfig, so here it's a plain wildcard
    return "*";
  }
  if (requestOrigin === null) {
    return null;
  }
  if (typeof allowed === "string") {
    return allowed;
  }
  if (Array.isArray(allowed)) {
    return allowed.includes(requestOrigin) ? requestOrigin : null;
  }
  return allowed(requestOrigin) ? requestOrigin : null;
}

/** CORS headers for actual (non-preflight) requests. */
export function corsHeaders(options: CorsOptions = {}): Middleware {
  assertOriginConfig(options);
  return (req) => {
    const origin = resolveOrigin(req.headers.get("origin"), options);
    if (origin !== null) {
      req.setResponseHeader("Access-Control-Allow-Origin", origin);
      if (origin !== "*") {
        // reflected origin varies per request; caches must key on it
        req.appendResponseHeader("Vary", "Origin");
      }
      // allow-credentials is meaningful only next to an allowed origin
      if (options.credentials) {
        req.setResponseHeader("Access-Control-Allow-Credentials", "true");
      }
    }
    if (options.exposedHeaders?.length) {
      req.setResponseHeader("Access-Control-Expose-Headers", options.exposedHeaders.join(", "));
    }
  };
}

/** Answers a CORS preflight `OPTIONS` with `204`. */
export function corsPreflight(options: CorsOptions = {}): Handler {
  assertOriginConfig(options);
  return (req) => {
    const origin = resolveOrigin(req.headers.get("origin"), options);
    if (origin !== null) {
      req.setResponseHeader("Access-Control-Allow-Origin", origin);
      // a reflected origin varies per request; a shared cache must key the preflight on it
      if (origin !== "*") req.appendResponseHeader("Vary", "Origin");
      if (options.credentials) {
        req.setResponseHeader("Access-Control-Allow-Credentials", "true");
      }
    }
    req.setResponseHeader(
      "Access-Control-Allow-Methods",
      (options.methods ?? DEFAULT_METHODS).join(", "),
    );
    const requested = req.headers.get("access-control-request-headers");
    req.setResponseHeader(
      "Access-Control-Allow-Headers",
      options.allowedHeaders?.join(", ") ?? requested ?? "*",
    );
    if (options.maxAge !== undefined) {
      req.setResponseHeader("Access-Control-Max-Age", String(options.maxAge));
    }
    return reply.empty(204);
  };
}

export interface SecurityOptions {
  /** `X-Frame-Options`. Default `"DENY"`. */
  frameOptions?: string;
  /** `Referrer-Policy`. Default `"no-referrer"`. */
  referrerPolicy?: string;
  /** HSTS max-age in seconds, or `true` for ~180 days. Off by default. */
  hsts?: number | true;
  /** `Content-Security-Policy`. Off by default. */
  csp?: string;
}

/** Defaults favor speed over ratio. */
export interface CompressionOptions {
  /** min body bytes to compress. Default 1024. */
  threshold?: number;
  /** gzip level 0–9. Default 6. */
  gzipLevel?: number;
  /** brotli quality 0–11. Default 5. */
  brotliQuality?: number;
}

/** onResponse hook: brotli/gzip per `Accept-Encoding`, off the event loop (libuv pool). */
export function compression(options: CompressionOptions = {}): ResponseHook {
  const threshold = options.threshold ?? 1024;
  const gzipLevel = options.gzipLevel ?? 6;
  const brotliQuality = options.brotliQuality ?? 5;
  return async (req, res) => {
    if (typeof res.body !== "string" || Buffer.byteLength(res.body) < threshold) {
      return;
    }
    if (!isCompressible(res.contentType)) {
      return;
    }
    const accept = req.headers.get("accept-encoding") ?? "";
    const encoding = acceptsEncoding(accept, "br")
      ? "br"
      : acceptsEncoding(accept, "gzip")
        ? "gzip"
        : null;
    if (encoding === null) {
      return;
    }
    const input = Buffer.from(res.body);
    const compressed =
      encoding === "br"
        ? await brotliAsync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: brotliQuality } })
        : await gzipAsync(input, { level: gzipLevel });
    return rawResponse(res.status, res.contentType, new Uint8Array(compressed), [
      ...res.headers,
      ["Content-Encoding", encoding],
      ["Vary", "Accept-Encoding"],
    ]);
  };
}

/** Baseline hardening headers on every response. */
export function securityHeaders(options: SecurityOptions = {}): Middleware {
  return (req) => {
    req.setResponseHeader("X-Content-Type-Options", "nosniff");
    req.setResponseHeader("X-Frame-Options", options.frameOptions ?? "DENY");
    req.setResponseHeader("Referrer-Policy", options.referrerPolicy ?? "no-referrer");
    if (options.hsts) {
      const maxAge = options.hsts === true ? 15552000 : options.hsts;
      req.setResponseHeader("Strict-Transport-Security", `max-age=${maxAge}; includeSubDomains`);
    }
    if (options.csp) {
      req.setResponseHeader("Content-Security-Policy", options.csp);
    }
  };
}
