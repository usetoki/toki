import { keyring } from "./keyring.js";
import { seal as sealValue, unseal as unsealValue } from "./seal.js";
import { sign as signValue, unsign as unsignValue } from "./sign.js";

export interface CookieCryptoOptions {
  /** One or more secrets (each >= 16 bytes). The first is current; the rest are still
   *  accepted, so you can rotate by prepending a new secret. */
  secret: string | string[] | Buffer | Buffer[];
}

export interface Cookies {
  /** HMAC-sign a value; the value stays readable in the cookie. */
  sign(value: string): string;
  /** Verify a signed value, or `null` if missing/tampered/unknown key. */
  unsign(signed: string): string | null;
  /** Encrypt a value (AES-256-GCM); the cookie is opaque. */
  seal(value: string): string;
  /** Decrypt a sealed value, or `null` if tampered/unknown key. */
  unseal(sealed: string): string | null;
}

/** Build cookie signers/sealers over a rotating set of secrets. The base layer used by
 *  the session plugins; also usable directly with `req.setCookie` / `req.cookies`. */
export function createCookies(options: CookieCryptoOptions): Cookies {
  const ring = keyring(options.secret);
  const signKey = ring.signKeys[0]!;
  const sealKey = ring.sealKeys[0]!;
  return {
    sign: (value) => signValue(value, signKey),
    unsign: (signed) => unsignValue(signed, ring.signKeys),
    seal: (value) => sealValue(value, sealKey),
    unseal: (sealed) => unsealValue(sealed, ring.sealKeys),
  };
}
