import type { CookieOptions, Middleware, ResponseHook, TokiInstance } from "@usetoki/toki";
import { createCookies } from "@usetoki/toki-cookie";
import { decode, encode, type SessionData } from "./codec.js";
import { CookieSession, type Session } from "./session.js";

declare module "@usetoki/toki" {
  interface TokiRequest {
    session: Session;
  }
}

export interface SessionCookieOptions {
  name?: string;
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitioned?: boolean;
}

export interface SecureSessionOptions {
  /** secret(s) for AES-256-GCM (each >= 16 bytes); the first is current, the rest rotate. */
  secret: string | string[] | Buffer | Buffer[];
  /** session lifetime in seconds; 0 disables expiry. Default 86400 (one day). */
  maxAge?: number;
  /** re-issue the cookie on every response to slide the expiry. Default false. */
  rolling?: boolean;
  cookie?: SessionCookieOptions;
}

// browsers cap a cookie near 4 KiB and silently drop anything larger.
const MAX_COOKIE_BYTES = 4096;

/** Stateless sessions stored entirely in an encrypted cookie — no server-side store.
 *  Call it on the app (or any scope) to give `req.session` to that scope's routes. */
export function secureSession(instance: TokiInstance, options: SecureSessionOptions): void {
  const cookies = createCookies({ secret: options.secret });
  const maxAge = options.maxAge ?? 86400;
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    throw new RangeError(
      `secure-session: maxAge must be a positive number of seconds, got ${maxAge}`,
    );
  }
  const ttlMs = maxAge * 1000;
  const rolling = options.rolling ?? false;
  const name = options.cookie?.name ?? "session";

  const attrs: CookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    ...withoutName(options.cookie),
  };
  if (ttlMs > 0) attrs.maxAge = Math.floor(ttlMs / 1000);

  const load: Middleware = (req) => {
    const raw = req.cookies[name];
    req.session = new CookieSession(raw ? decode(cookies, raw) : null);
  };

  const save: ResponseHook = (req) => {
    const session = req.session as CookieSession;
    if (session.destroyed) {
      req.clearCookie(name, attrs);
      return;
    }
    if (!session.dirty && !(rolling && session.loaded)) return;
    const token = encode(cookies, session.data as SessionData, ttlMs);
    if (token.length > MAX_COOKIE_BYTES) {
      throw new Error(
        "toki-secure-session: session exceeds the ~4KB cookie limit — switch to toki-session with a store",
      );
    }
    req.setCookie(name, token, attrs);
  };

  instance.addHook("onRequest", load);
  instance.addHook("onSend", save);
}

function withoutName(cookie: SessionCookieOptions | undefined): CookieOptions {
  if (cookie === undefined) return {};
  const { name: _name, ...rest } = cookie;
  return rest;
}
