import type { Middleware } from "@usetoki/toki";
import { buildCsp, type CspDirectives, DEFAULT_CSP } from "./csp.js";

/** HSTS knobs; `true` uses the defaults below. */
export interface HstsOptions {
  /** `max-age` in seconds. Default ~180 days. */
  maxAge?: number;
  /** Append `includeSubDomains`. Default `true`. */
  includeSubDomains?: boolean;
  /** Append `preload` (only set once you've submitted to the HSTS preload list). Default `false`. */
  preload?: boolean;
}

/** CSP config; an object merges over {@link DEFAULT_CSP} unless `useDefaults` is `false`. */
export interface CspOptions {
  directives?: CspDirectives;
  useDefaults?: boolean;
}

/**
 * Each field defaults to a safe value and accepts `false` to drop the header, or a
 * string to override it. CSP and HSTS take richer config objects.
 */
export interface HelmetOptions {
  /** `Content-Security-Policy`. Default: helmet's baseline policy. `false` disables. */
  contentSecurityPolicy?: boolean | CspOptions;
  /** `Cross-Origin-Embedder-Policy`. Off by default — it blocks cross-origin sub-resources. `true` → `require-corp`. */
  crossOriginEmbedderPolicy?: boolean | string;
  /** `Cross-Origin-Opener-Policy`. Default `same-origin`. */
  crossOriginOpenerPolicy?: boolean | string;
  /** `Cross-Origin-Resource-Policy`. Default `same-origin`. */
  crossOriginResourcePolicy?: boolean | string;
  /** `Origin-Agent-Cluster: ?1`. Default on. */
  originAgentCluster?: boolean;
  /** `Referrer-Policy`. Default `no-referrer`. */
  referrerPolicy?: boolean | string;
  /** `Strict-Transport-Security`. Default on (~180 days, `includeSubDomains`). */
  hsts?: boolean | HstsOptions;
  /** `X-Content-Type-Options: nosniff`. Default on. */
  noSniff?: boolean;
  /** `X-DNS-Prefetch-Control`. Default `off`. */
  dnsPrefetchControl?: boolean | string;
  /** `X-Download-Options: noopen` (legacy IE). Default on. */
  ieNoOpen?: boolean;
  /** `X-Frame-Options`. Default `SAMEORIGIN`. Prefer CSP `frame-ancestors` for new apps. */
  frameguard?: boolean | "DENY" | "SAMEORIGIN";
  /** `X-Permitted-Cross-Domain-Policies`. Default `none`. */
  permittedCrossDomainPolicies?: boolean | string;
  /** `X-XSS-Protection: 0` — disables the legacy, exploitable auditor. Default on. */
  xssProtection?: boolean;
}

type Header = readonly [name: string, value: string];

// set unless explicitly disabled; a string overrides the default value
function toggle(
  out: Header[],
  name: string,
  option: boolean | string | undefined,
  value: string,
): void {
  if (option === false) return;
  out.push([name, typeof option === "string" ? option : value]);
}

function resolveCsp(option: boolean | CspOptions | undefined): CspDirectives {
  if (typeof option !== "object") return DEFAULT_CSP;
  if (option.useDefaults === false) return option.directives ?? {};
  return { ...DEFAULT_CSP, ...option.directives };
}

function hstsValue(option: boolean | HstsOptions | undefined): string {
  const config: HstsOptions = typeof option === "object" ? option : {};
  let value = `max-age=${config.maxAge ?? 15552000}`;
  if (config.includeSubDomains !== false) value += "; includeSubDomains";
  if (config.preload) value += "; preload";
  return value;
}

// the header set is fixed at construction; per request we only copy it onto the response
function buildHeaders(options: HelmetOptions): Header[] {
  const headers: Header[] = [];

  if (options.contentSecurityPolicy !== false) {
    headers.push(["Content-Security-Policy", buildCsp(resolveCsp(options.contentSecurityPolicy))]);
  }
  if (options.crossOriginEmbedderPolicy) {
    const value =
      typeof options.crossOriginEmbedderPolicy === "string"
        ? options.crossOriginEmbedderPolicy
        : "require-corp";
    headers.push(["Cross-Origin-Embedder-Policy", value]);
  }
  toggle(headers, "Cross-Origin-Opener-Policy", options.crossOriginOpenerPolicy, "same-origin");
  toggle(headers, "Cross-Origin-Resource-Policy", options.crossOriginResourcePolicy, "same-origin");
  if (options.originAgentCluster !== false) headers.push(["Origin-Agent-Cluster", "?1"]);
  toggle(headers, "Referrer-Policy", options.referrerPolicy, "no-referrer");
  if (options.hsts !== false) headers.push(["Strict-Transport-Security", hstsValue(options.hsts)]);
  if (options.noSniff !== false) headers.push(["X-Content-Type-Options", "nosniff"]);
  toggle(headers, "X-DNS-Prefetch-Control", options.dnsPrefetchControl, "off");
  if (options.ieNoOpen !== false) headers.push(["X-Download-Options", "noopen"]);
  toggle(headers, "X-Frame-Options", options.frameguard, "SAMEORIGIN");
  toggle(
    headers,
    "X-Permitted-Cross-Domain-Policies",
    options.permittedCrossDomainPolicies,
    "none",
  );
  if (options.xssProtection !== false) headers.push(["X-XSS-Protection", "0"]);

  return headers;
}

/**
 * Middleware that stages a set of hardening headers on every response. Use it on the
 * app, a scope, a group, or a single route's `preHandler`. Headers ride along on
 * error and not-found responses too.
 */
export function helmet(options: HelmetOptions = {}): Middleware {
  const headers = buildHeaders(options);
  return (req) => {
    for (const [name, value] of headers) {
      req.setResponseHeader(name, value);
    }
  };
}
