import { hkdfSync } from "node:crypto";

// Separate signing and sealing keys, derived from each secret via HKDF. A secret is
// never used raw, and the two purposes can't cross-contaminate.
const SIGN_INFO = Buffer.from("toki-cookie/sign");
const SEAL_INFO = Buffer.from("toki-cookie/seal");
const KEY_LEN = 32; // HMAC-SHA256 key + AES-256 key
const MIN_SECRET = 16;

export interface Keyring {
  /** index 0 is the current key; the rest are kept for rotation */
  readonly signKeys: readonly Buffer[];
  readonly sealKeys: readonly Buffer[];
}

/** Derive signing + sealing keys from one or more secrets. The first secret is used
 *  to produce new cookies; all are accepted when verifying, so secrets can be rotated
 *  by prepending a new one and dropping the oldest later. */
export function keyring(secrets: string | string[] | Buffer | Buffer[]): Keyring {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).map(toKey);
  if (list.length === 0) throw new Error("toki-cookie: at least one secret is required");
  return {
    signKeys: list.map((s) => derive(s, SIGN_INFO)),
    sealKeys: list.map((s) => derive(s, SEAL_INFO)),
  };
}

function derive(secret: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, KEY_LEN));
}

function toKey(secret: string | Buffer): Buffer {
  const buf = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (buf.length < MIN_SECRET)
    throw new Error("toki-cookie: each secret must be at least 16 bytes");
  return buf;
}
