import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

// X25519 (Curve25519) Diffie-Hellman, the DH function for the Noise suite. Node has X25519
// natively; the only work here is moving between raw 32-byte keys (what goes on the wire and
// what callers persist) and the KeyObjects node's crypto wants.

export const DHLEN = 32;

// Fixed ASN.1 prefixes for a 32-byte X25519 key — lets us wrap/unwrap raw keys without
// pulling in an ASN.1 library. The 32 key bytes get appended.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // public (SubjectPublicKeyInfo)
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex"); // private (PKCS#8)

/** A DH key pair as node KeyObjects, plus the raw 32-byte public key for the wire. */
export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicRaw: Buffer;
}

/** A fresh ephemeral (or static) X25519 key pair. */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKey, publicRaw: rawPublic(publicKey) };
}

/** Reconstruct a key pair from a stored 32-byte private scalar (the public is derived). */
export function keyPairFromPrivateRaw(privateRaw: Uint8Array): KeyPair {
  if (privateRaw.length !== DHLEN) {
    throw new RangeError(`x25519 private key must be ${DHLEN} bytes, got ${privateRaw.length}`);
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateRaw)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, publicRaw: rawPublic(publicKey) };
}

/** The raw 32-byte public key of a key object. */
export function rawPublic(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: "spki", format: "der" });
  // a valid X25519 SPKI is exactly the 12-byte prefix + 32 key bytes; anything else is the
  // wrong key type and slicing the tail would silently return garbage.
  if (der.length !== SPKI_PREFIX.length + DHLEN) {
    throw new Error("dh: not an X25519 public key");
  }
  return Buffer.from(der.subarray(der.length - DHLEN));
}

/** Wrap a peer's raw 32-byte public key (off the wire) into a KeyObject. */
export function publicFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== DHLEN) {
    throw new RangeError(`x25519 public key must be ${DHLEN} bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

/** DH(privateKey, peerPublicRaw) -> 32-byte shared secret. */
export function dh(privateKey: KeyObject, peerPublicRaw: Uint8Array): Buffer {
  return diffieHellman({ privateKey, publicKey: publicFromRaw(peerPublicRaw) });
}
