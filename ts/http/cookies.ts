/** Options for a `Set-Cookie` header. */
export interface CookieOptions {
  path?: string;
  domain?: string;
  /** Lifetime in seconds. */
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Chrome's cookie partitioning. */
  partitioned?: boolean;
}

const COOKIE_NAME = /^[\w!#$%&'*.^`|~+-]+$/;

/** Parses a `Cookie` header into a name → value map. Duplicate names: first wins. */
export function parseCookies(header: string): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (name.length === 0 || name in out) {
      continue;
    }
    let value = eq === -1 ? "" : part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return Object.freeze(out);
}

/** Serializes one `Set-Cookie` header value. Throws on an invalid name. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME.test(name)) {
    throw new TypeError(`Invalid cookie name: ${name}`);
  }
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (options.maxAge !== undefined) {
    cookie += `; Max-Age=${Math.trunc(options.maxAge)}`;
  }
  if (options.domain) {
    cookie += `; Domain=${options.domain}`;
  }
  cookie += `; Path=${options.path ?? "/"}`;
  if (options.expires) {
    cookie += `; Expires=${options.expires.toUTCString()}`;
  }
  if (options.httpOnly) {
    cookie += "; HttpOnly";
  }
  if (options.secure) {
    cookie += "; Secure";
  }
  if (options.partitioned) {
    cookie += "; Partitioned";
  }
  if (options.sameSite) {
    cookie += `; SameSite=${options.sameSite}`;
  }
  return cookie;
}
