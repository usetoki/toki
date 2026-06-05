import {
  constants,
  createHmac,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import type { JwtAlgorithm, KeyInput } from "./types.js";

type Family = "hmac" | "rsa" | "pss" | "ecdsa" | "eddsa";

interface Spec {
  family: Family;
  /** node digest name; null for EdDSA (no separate hash) */
  hash: string | null;
}

const SPECS: Record<JwtAlgorithm, Spec> = {
  HS256: { family: "hmac", hash: "sha256" },
  HS384: { family: "hmac", hash: "sha384" },
  HS512: { family: "hmac", hash: "sha512" },
  RS256: { family: "rsa", hash: "sha256" },
  RS384: { family: "rsa", hash: "sha384" },
  RS512: { family: "rsa", hash: "sha512" },
  PS256: { family: "pss", hash: "sha256" },
  PS384: { family: "pss", hash: "sha384" },
  PS512: { family: "pss", hash: "sha512" },
  ES256: { family: "ecdsa", hash: "sha256" },
  ES384: { family: "ecdsa", hash: "sha384" },
  ES512: { family: "ecdsa", hash: "sha512" },
  EdDSA: { family: "eddsa", hash: null },
};

const PSS = {
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
};

export function isAlgorithm(alg: string): alg is JwtAlgorithm {
  return Object.prototype.hasOwnProperty.call(SPECS, alg);
}

export function signData(alg: JwtAlgorithm, data: Buffer, key: KeyInput): Buffer {
  const spec = SPECS[alg];
  switch (spec.family) {
    case "hmac":
      return createHmac(spec.hash!, key as Buffer | string)
        .update(data)
        .digest();
    case "rsa":
      return cryptoSign(spec.hash, data, toPrivate(key));
    case "pss":
      return cryptoSign(spec.hash, data, { key: toPrivate(key), ...PSS });
    case "ecdsa":
      // JWS carries the raw r||s signature, not DER
      return cryptoSign(spec.hash, data, { key: toPrivate(key), dsaEncoding: "ieee-p1363" });
    case "eddsa":
      return cryptoSign(null, data, toPrivate(key));
  }
}

export function verifyData(
  alg: JwtAlgorithm,
  data: Buffer,
  signature: Buffer,
  key: KeyInput,
): boolean {
  const spec = SPECS[alg];
  switch (spec.family) {
    case "hmac": {
      const expected = createHmac(spec.hash!, key as Buffer | string)
        .update(data)
        .digest();
      return expected.length === signature.length && timingSafeEqual(expected, signature);
    }
    case "rsa":
      return cryptoVerify(spec.hash, data, toPublic(key), signature);
    case "pss":
      return cryptoVerify(spec.hash, data, { key: toPublic(key), ...PSS }, signature);
    case "ecdsa":
      return cryptoVerify(
        spec.hash,
        data,
        { key: toPublic(key), dsaEncoding: "ieee-p1363" },
        signature,
      );
    case "eddsa":
      return cryptoVerify(null, data, toPublic(key), signature);
  }
}

function toPrivate(key: KeyInput): KeyObject {
  return key instanceof KeyObject ? key : createPrivateKey(key);
}

function toPublic(key: KeyInput): KeyObject {
  return key instanceof KeyObject ? key : createPublicKey(key);
}
