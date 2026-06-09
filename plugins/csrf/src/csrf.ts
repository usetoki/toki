import { randomBytes, timingSafeEqual } from "node:crypto";
import { reply } from "@usetoki/toki";
import type { CookieOptions, TokiInstance, TokiRequest } from "@usetoki/toki";
import { createCookies } from "@usetoki/toki-cookie";
import { originAllowed } from "./origin.js";

declare module "@usetoki/toki" {
  interface TokiRequest {
    /** Mint a CSRF token: signs it into the response cookie and returns the raw value
     *  to embed in a form field or send back as a header on the next unsafe request. */
    csrfToken(): string;
  }
}

// one token per request: repeat csrfToken() calls (two forms on a page) return the same
// value instead of each minting a fresh token and clobbering the previous cookie
const issued = new WeakMap<TokiRequest, string>();

export interface CsrfCookieOptions extends CookieOptions {
  name?: string;
}

export interface CsrfOptions {
  /** Secret(s) used to sign the token cookie (each >= 16 bytes), newest first. */
  secret: string | string[] | Buffer | Buffer[];
  cookie?: CsrfCookieOptions;
  /** Extract the submitted token. Default: `x-csrf-token`/`csrf-token` header, then a `_csrf` form field. */
  getToken?: (req: TokiRequest) => string | undefined;
  /** Methods that skip the check. Default `["GET", "HEAD", "OPTIONS"]`. */
  ignoreMethods?: string[];
  /** Also require a trusted Origin/Referer. `true` = same host; an array = an allow-list of hosts. */
  checkOrigin?: boolean | string[];
  /** Status for a rejected request. Default `403`. */
  statusCode?: number;
}

/**
 * Signed double-submit CSRF protection. `req.csrfToken()` issues a random token, signs
 * it into a cookie, and returns the raw value for the page to send back (a hidden form
 * field or a header). On every unsafe request the submitted token must equal the one
 * unsealed from the cookie, and (optionally) the Origin must be trusted. The HMAC
 * signature stops an attacker forging the cookie; the cookie is `HttpOnly` by default.
 */
export function csrf(instance: TokiInstance, options: CsrfOptions): void {
  const cookies = createCookies({ secret: options.secret });
  const name = options.cookie?.name ?? "_csrf";
  const attrs: CookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    ...withoutName(options.cookie),
  };
  const ignore = new Set(
    (options.ignoreMethods ?? ["GET", "HEAD", "OPTIONS"]).map((m) => m.toUpperCase()),
  );
  const readToken = options.getToken ?? defaultToken;
  const status = options.statusCode ?? 403;
  const origins = normalizeOrigins(options.checkOrigin);

  instance.addHook("onRequest", (req) => {
    req.csrfToken = () => {
      const existing = issued.get(req);
      if (existing !== undefined) return existing;
      const token = randomBytes(18).toString("base64url");
      issued.set(req, token);
      req.setCookie(name, cookies.sign(token), attrs);
      return token;
    };
    return undefined;
  });

  instance.addHook("preHandler", (req) => {
    if (ignore.has(req.method)) return undefined;

    if (origins !== false && !originAllowed(req, origins === true ? null : origins)) {
      return reply.text("invalid origin", status);
    }

    const cookie = req.cookies[name];
    const expected = cookie !== undefined ? cookies.unsign(cookie) : null;
    const submitted = readToken(req);
    if (expected === null || submitted === undefined || !safeEqual(expected, submitted)) {
      return reply.text("invalid csrf token", status);
    }
    return undefined;
  });
}

function normalizeOrigins(check: CsrfOptions["checkOrigin"]): boolean | readonly string[] {
  if (check === undefined || check === false) return false;
  return check === true ? true : check;
}

function withoutName(cookie: CsrfCookieOptions | undefined): CookieOptions {
  if (cookie === undefined) return {};
  const { name: _name, ...rest } = cookie;
  return rest;
}

function defaultToken(req: TokiRequest): string | undefined {
  return (
    req.headers.get("x-csrf-token") ?? req.headers.get("csrf-token") ?? req.form?.fields["_csrf"]
  );
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
