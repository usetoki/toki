import type { TokiResponse } from "./response";

/** `Set-Cookie` attributes, covering the RFC 6265 fields most applications need. */
export interface CookieOptions {
  path?: string;
  domain?: string;
  /** `Max-Age`, in seconds. `0` expires the cookie immediately. */
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | "strict" | "lax" | "none";
}

/** Parse a `Cookie` header into a frozen name → value map; malformed pairs are skipped. */
export function parseCookies(header: string | null): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  if (!header) {
    return Object.freeze(out);
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name.length === 0) {
      continue;
    }
    let value = part.slice(eq + 1).trim();
    // Strip a single layer of surrounding double quotes, per RFC 6265.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // Leave a non-decodable value as-is rather than dropping the cookie.
      out[name] = value;
    }
  }
  return Object.freeze(out);
}

/** Serialize a single cookie into a `Set-Cookie` value; name and value are percent-encoded. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!/^[\w!#$%&'*.^`|~+-]+$/.test(name)) {
    throw new TypeError(`invalid cookie name: ${JSON.stringify(name)}`);
  }
  let out = `${name}=${encodeURIComponent(value)}`;

  if (options.maxAge !== undefined) {
    if (!Number.isInteger(options.maxAge)) {
      throw new TypeError("cookie maxAge must be an integer number of seconds");
    }
    out += `; Max-Age=${options.maxAge}`;
  }
  if (options.domain !== undefined) {
    out += `; Domain=${options.domain}`;
  }
  if (options.path !== undefined) {
    out += `; Path=${options.path}`;
  }
  if (options.expires !== undefined) {
    out += `; Expires=${options.expires.toUTCString()}`;
  }
  if (options.httpOnly) {
    out += "; HttpOnly";
  }
  if (options.secure) {
    out += "; Secure";
  }
  if (options.sameSite !== undefined) {
    const normalized = normalizeSameSite(options.sameSite);
    out += `; SameSite=${normalized}`;
  }
  return out;
}

function normalizeSameSite(value: NonNullable<CookieOptions["sameSite"]>): string {
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Append a `Set-Cookie` header to a response, returning it for chaining. */
export function setCookie(
  response: TokiResponse,
  name: string,
  value: string,
  options: CookieOptions = {},
): TokiResponse {
  response.headers.append("set-cookie", serializeCookie(name, value, options));
  return response;
}
