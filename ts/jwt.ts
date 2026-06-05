// HMAC-SHA JWT (HS256/384/512). signing stays in node:crypto's native C; no win re-doing SHA in Zig
import { createHmac, timingSafeEqual } from "node:crypto";
import { reply } from "./response.js";
import type { Middleware } from "./types.js";

const ALGORITHMS = { HS256: "sha256", HS384: "sha384", HS512: "sha512" } as const;
export type JwtAlgorithm = keyof typeof ALGORITHMS;

/** Decoded payload; registered claims typed, rest open. */
export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  [claim: string]: unknown;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtError";
  }
}

export interface SignOptions {
  algorithm?: JwtAlgorithm;
  /** Seconds until the token expires (sets `exp`). */
  expiresIn?: number;
  /** Seconds until the token becomes valid (sets `nbf`). */
  notBefore?: number;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
}

export interface VerifyOptions {
  /** Accepted algs. Defaults to whatever the token claims, restricted to HS*. */
  algorithms?: JwtAlgorithm[];
  /** Require this `iss`. */
  issuer?: string;
  /** Must equal `aud`, or be in it when `aud` is an array. */
  audience?: string;
  /** Clock-skew tolerance in seconds for `exp`/`nbf`. Default 0. */
  clockTolerance?: number;
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(alg: JwtAlgorithm, secret: string, data: string): string {
  return createHmac(ALGORITHMS[alg], secret).update(data).digest("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Sign `payload` into a compact JWS string. */
export function signJwt(payload: JwtPayload, secret: string, options: SignOptions = {}): string {
  const alg = options.algorithm ?? "HS256";
  const claims: JwtPayload = { iat: nowSeconds(), ...payload };
  if (options.expiresIn !== undefined) claims.exp = nowSeconds() + options.expiresIn;
  if (options.notBefore !== undefined) claims.nbf = nowSeconds() + options.notBefore;
  if (options.issuer !== undefined) claims.iss = options.issuer;
  if (options.audience !== undefined) claims.aud = options.audience;
  if (options.subject !== undefined) claims.sub = options.subject;

  const header = b64urlEncode(JSON.stringify({ alg, typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify(claims));
  const data = `${header}.${body}`;
  return `${data}.${sign(alg, secret, data)}`;
}

// constant-time compare; timingSafeEqual throws on length mismatch, so length-check first
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Verify `token`, returning its payload or throwing {@link JwtError}. */
export function verifyJwt(token: string, secret: string, options: VerifyOptions = {}): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtError("malformed token");
  }
  const [header, body, signature] = parts as [string, string, string];

  let alg: JwtAlgorithm;
  try {
    alg = (JSON.parse(b64urlDecode(header)) as { alg: JwtAlgorithm }).alg;
  } catch {
    throw new JwtError("malformed header");
  }
  if (!(alg in ALGORITHMS)) {
    throw new JwtError(`unsupported algorithm: ${alg}`);
  }
  if (options.algorithms && !options.algorithms.includes(alg)) {
    throw new JwtError(`algorithm not allowed: ${alg}`);
  }
  if (!safeEqual(signature, sign(alg, secret, `${header}.${body}`))) {
    throw new JwtError("invalid signature");
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(b64urlDecode(body)) as JwtPayload;
  } catch {
    throw new JwtError("malformed payload");
  }

  const skew = options.clockTolerance ?? 0;
  const now = nowSeconds();
  if (typeof payload.exp === "number" && now >= payload.exp + skew) {
    throw new JwtError("token expired");
  }
  if (typeof payload.nbf === "number" && now < payload.nbf - skew) {
    throw new JwtError("token not yet active");
  }
  if (options.issuer !== undefined && payload.iss !== options.issuer) {
    throw new JwtError("issuer mismatch");
  }
  if (options.audience !== undefined) {
    const aud = payload.aud;
    const ok = Array.isArray(aud) ? aud.includes(options.audience) : aud === options.audience;
    if (!ok) {
      throw new JwtError("audience mismatch");
    }
  }
  return payload;
}

export interface JwtAuthOptions extends VerifyOptions {
  secret: string;
  /** Custom token extraction (e.g. cookie); null when absent. Defaults to Bearer header. */
  getToken?: (req: {
    headers: Headers;
    cookies: Readonly<Record<string, string | undefined>>;
  }) => string | null;
  /** Request property to attach the payload to. Default `"user"`. */
  decorateAs?: string;
}

function bearerToken(req: { headers: Headers }): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1]! : null;
}

/** Middleware: verify JWT, attach payload (default `req.user`), or 401. */
export function jwtAuth(options: JwtAuthOptions): Middleware {
  const getToken = options.getToken ?? bearerToken;
  const property = options.decorateAs ?? "user";
  return (req) => {
    const token = getToken(req);
    if (!token) {
      return reply.json({ statusCode: 401, error: "Unauthorized", message: "missing token" }, 401);
    }
    try {
      (req as unknown as Record<string, unknown>)[property] = verifyJwt(
        token,
        options.secret,
        options,
      );
      return undefined;
    } catch (error) {
      const message = error instanceof JwtError ? error.message : "invalid token";
      return reply.json({ statusCode: 401, error: "Unauthorized", message }, 401);
    }
  };
}
