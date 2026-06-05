import type { KeyObject } from "node:crypto";

export type JwtAlgorithm =
  | "HS256"
  | "HS384"
  | "HS512"
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "ES512"
  | "EdDSA";

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
  [field: string]: unknown;
}

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

/** A PEM string, raw secret bytes, or a node KeyObject. */
export type KeyInput = string | Buffer | KeyObject;

/** Picks the verification key for a token from its header (e.g. by `kid` against a JWKS). */
export type KeyResolver = (header: JwtHeader) => KeyInput | Promise<KeyInput>;
