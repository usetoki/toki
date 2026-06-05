import { createHmac, timingSafeEqual } from "node:crypto";

// `value.signature` — the value stays readable, the HMAC tag proves it wasn't changed.

export function sign(value: string, key: Buffer): string {
  return `${value}.${tag(value, key)}`;
}

export function unsign(token: string, keys: readonly Buffer[]): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const value = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1), "base64url");
  for (const key of keys) {
    const want = Buffer.from(tag(value, key), "base64url");
    if (got.length === want.length && timingSafeEqual(got, want)) return value;
  }
  return null;
}

function tag(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}
