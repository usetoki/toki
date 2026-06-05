import type { Cookies } from "@usetoki/toki-cookie";

export type SessionData = Record<string, unknown>;

// the sealed cookie carries [expiresAtMs, data]; expiresAt 0 means no absolute expiry.
type Envelope = [number, SessionData];

export function encode(cookies: Cookies, data: SessionData, ttlMs: number): string {
  const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
  return cookies.seal(JSON.stringify([expiresAt, data] satisfies Envelope));
}

export function decode(cookies: Cookies, token: string): SessionData | null {
  const json = cookies.unseal(token);
  if (json === null) return null;
  let env: unknown;
  try {
    env = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(env) || env.length !== 2) return null;
  const [expiresAt, data] = env as [unknown, unknown];
  if (typeof expiresAt !== "number" || typeof data !== "object" || data === null) return null;
  if (expiresAt > 0 && Date.now() > expiresAt) return null; // expired
  return data as SessionData;
}
