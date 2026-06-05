import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison for secrets (passwords, API keys). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
