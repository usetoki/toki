import { isAlgorithm, verifyData } from "./algorithms.ts";
import { decode, decodeJson } from "./base64url.ts";
import { validateClaims } from "./claims.ts";
import { JwtError } from "./errors.ts";
import type { JwtAlgorithm, JwtHeader, JwtPayload, KeyInput, KeyResolver } from "./types.ts";

export interface VerifyOptions {
  /** allowed algorithms — REQUIRED; the token's alg must be one of these (guards against
   *  algorithm-confusion attacks and `alg: none`). */
  algorithms: JwtAlgorithm[];
  issuer?: string | string[];
  audience?: string | string[];
  subject?: string;
  /** seconds of leeway for exp/nbf. Default 0. */
  clockTolerance?: number;
  /** override the current time in seconds (testing). */
  now?: number;
}

/** Verify and decode a JWT. `key` is a public key / HMAC secret, or a resolver (JWKS). */
export async function verifyJwt(
  token: string,
  key: KeyInput | KeyResolver,
  options: VerifyOptions,
): Promise<JwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: JwtHeader;
  try {
    header = decodeJson<JwtHeader>(headerB64);
  } catch {
    throw new JwtError("malformed header");
  }
  if (typeof header.alg !== "string" || !options.algorithms.includes(header.alg as JwtAlgorithm)) {
    throw new JwtError(`algorithm not allowed: ${String(header.alg)}`);
  }
  if (!isAlgorithm(header.alg)) throw new JwtError(`unsupported algorithm: ${header.alg}`);

  const resolved = typeof key === "function" ? await key(header) : key;
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  if (!verifyData(header.alg, signingInput, decode(signatureB64), resolved)) {
    throw new JwtError("invalid signature");
  }

  let payload: JwtPayload;
  try {
    payload = decodeJson<JwtPayload>(payloadB64);
  } catch {
    throw new JwtError("malformed payload");
  }
  validateClaims(payload, {
    issuer: options.issuer,
    audience: options.audience,
    subject: options.subject,
    clockTolerance: options.clockTolerance ?? 0,
    now: options.now ?? Math.floor(Date.now() / 1000),
  });
  return payload;
}
