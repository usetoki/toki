import { signData } from "./algorithms.ts";
import { encode, encodeJson } from "./base64url.ts";
import type { JwtAlgorithm, JwtHeader, JwtPayload, KeyInput } from "./types.ts";

export interface SignOptions {
  algorithm: JwtAlgorithm;
  /** seconds until the token expires (sets `exp`) */
  expiresIn?: number;
  /** seconds before the token becomes valid (sets `nbf`) */
  notBefore?: number;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  /** `kid` header, e.g. to match a JWKS key */
  keyid?: string;
  /** extra header fields */
  header?: Record<string, unknown>;
}

/** Sign a JWT with a private key (RSA/EC/Ed) or an HMAC secret. */
export function signJwt(payload: JwtPayload, key: KeyInput, options: SignOptions): string {
  const now = Math.floor(Date.now() / 1000);
  // spread extras first so alg/typ stay authoritative. A caller-supplied header.alg must
  // not disagree with the algorithm the signature is actually computed with.
  const header: JwtHeader = { typ: "JWT", ...options.header, alg: options.algorithm };
  if (options.keyid !== undefined) header.kid = options.keyid;

  const claims: JwtPayload = { iat: now, ...payload };
  if (options.expiresIn !== undefined) {
    // a non-finite expiry would serialize to null and produce a token that never expires
    if (!Number.isFinite(options.expiresIn))
      throw new TypeError("jwt: expiresIn must be a finite number of seconds");
    claims.exp = now + options.expiresIn;
  }
  if (options.notBefore !== undefined) {
    if (!Number.isFinite(options.notBefore))
      throw new TypeError("jwt: notBefore must be a finite number of seconds");
    claims.nbf = now + options.notBefore;
  }
  if (options.issuer !== undefined) claims.iss = options.issuer;
  if (options.audience !== undefined) claims.aud = options.audience;
  if (options.subject !== undefined) claims.sub = options.subject;

  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = encode(signData(options.algorithm, Buffer.from(signingInput), key));
  return `${signingInput}.${signature}`;
}
