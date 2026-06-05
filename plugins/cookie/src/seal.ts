import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM with a fresh random IV per cookie. Layout: iv(12) | tag(16) | ciphertext.
// GCM authenticates, so a wrong key or any tampering fails decryption.
const IV_LEN = 12;
const TAG_LEN = 16;

export function seal(value: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal(token: string, keys: readonly Buffer[]): string | null {
  const raw = Buffer.from(token, "base64url");
  if (raw.length < IV_LEN + TAG_LEN) return null;
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = raw.subarray(IV_LEN + TAG_LEN);
  for (const key of keys) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      // wrong key (rotation) or tampered — try the next key
    }
  }
  return null;
}
