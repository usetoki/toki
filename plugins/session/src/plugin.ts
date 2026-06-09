import type { CookieOptions, Middleware, ResponseHook, TokiInstance } from "@usetoki/toki";
import { createCookies } from "@usetoki/toki-cookie";
import { newSessionId } from "./id.ts";
import { type Session, StoredSession } from "./session.ts";
import { MemoryStore, type SessionData, type SessionStore } from "./store.ts";

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

export interface SessionOptions {
  /** secret(s) used to sign the session id cookie (each >= 16 bytes), newest first. */
  secret: string | string[] | Buffer | Buffer[];
  /** where session data lives. Default: an in-process MemoryStore. */
  store?: SessionStore;
  /** session lifetime in seconds. Default 86400 (one day). */
  maxAge?: number;
  /** re-issue the cookie + touch the store on every response to slide the expiry. */
  rolling?: boolean;
  cookie?: SessionCookieOptions;
}

/** Stateful sessions: a signed id in a cookie, data in a pluggable store. Call it on
 *  the app (or any scope) to give `req.session` to that scope's routes. */
export function session(instance: TokiInstance, options: SessionOptions): void {
  const cookies = createCookies({ secret: options.secret });
  const store = options.store ?? new MemoryStore();
  const maxAge = options.maxAge ?? 86400;
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    // a zero/negative/NaN ttl produces an invalid store TTL (e.g. Redis PX 0)
    throw new RangeError(`session: maxAge must be a positive number of seconds, got ${maxAge}`);
  }
  const ttlMs = maxAge * 1000;
  const rolling = options.rolling ?? false;
  const name = options.cookie?.name ?? "sid";

  const attrs: CookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    ...withoutName(options.cookie),
  };
  if (ttlMs > 0) attrs.maxAge = Math.floor(ttlMs / 1000);

  const load: Middleware = async (req) => {
    const signed = req.cookies[name];
    let id = newSessionId();
    let data: SessionData | null = null;
    if (signed !== undefined) {
      const sid = cookies.unsign(signed);
      if (sid !== null) {
        const found = await store.get(sid);
        if (found !== null) {
          id = sid;
          data = found;
        }
      }
    }
    req.session = new StoredSession(id, data, (oldId) => {
      Promise.resolve(store.destroy(oldId)).catch(() => {});
    });
  };

  const save: ResponseHook = async (req) => {
    const session = req.session as StoredSession;
    if (session.oldId !== null) await store.destroy(session.oldId); // regenerate dropped it

    if (session.destroyed) {
      if (session.loaded) await store.destroy(session.id);
      req.clearCookie(name, attrs);
      return;
    }
    if (!session.dirty && !(rolling && session.loaded)) return;

    await store.set(session.id, session.data as SessionData, ttlMs);
    // the cookie only changes for a new or regenerated session, or to slide a rolling expiry
    if (!session.loaded || session.oldId !== null || rolling) {
      req.setCookie(name, cookies.sign(session.id), attrs);
    }
  };

  instance.addHook("onRequest", load);
  instance.addHook("onSend", save);
}

function withoutName(cookie: SessionCookieOptions | undefined): CookieOptions {
  if (cookie === undefined) return {};
  const { name: _name, ...rest } = cookie;
  return rest;
}
