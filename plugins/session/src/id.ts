import { randomBytes } from "node:crypto";

/** A fresh session id — 192 bits of entropy, URL-safe and unguessable. */
export function newSessionId(): string {
  return randomBytes(24).toString("base64url");
}
